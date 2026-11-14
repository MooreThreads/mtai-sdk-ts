#include "pipewire_output.h"
#include <spa/param/audio/format-utils.h>
#include <cerrno>
#include <mutex>
#include <system_error>

namespace mtai::avatar {
namespace {
void checked(int status,const char* action){if(status<0)throw std::system_error(-status,std::generic_category(),action);}
struct Lock {
  pw_thread_loop* loop;
  explicit Lock(pw_thread_loop* value):loop(value){pw_thread_loop_lock(loop);}
  ~Lock(){pw_thread_loop_unlock(loop);}
};
}
PipewireOutput::PipewireOutput(Target target,Layout layout,PcmCustody::Notify notify,void* data)
 :target_(std::move(target)),layout_(layout),notify_(notify),notify_data_(data),callbacks_(callbacks()) {
  validate_layout(layout_);if(!notify_)throw ProtocolError("output requires completion notification");
  // SPA raw audio representation, not a new media ceiling.
  if(layout_.channels>SPA_AUDIO_MAX_CHANNELS)throw ProtocolError("unsupported SPA channel representation");
}
PipewireOutput::~PipewireOutput(){if(!closed_ && (loop_ || custody_ || stream_))std::terminate();}
pw_stream_events PipewireOutput::callbacks(){
  pw_stream_events value{};value.version=PW_VERSION_STREAM_EVENTS;value.state_changed=state;
  value.param_changed=format;value.add_buffer=added;value.remove_buffer=removed;
  value.process=processing;value.drained=drained;return value;
}
void PipewireOutput::check(){if(cancelled_)throw ProtocolError("avatar output cancelled");int error=error_.load();if(error)checked(error,"PipeWire output failed");}
void PipewireOutput::request_cancel(){
  cancelled_=true;
  std::lock_guard<std::mutex> lifetime(loop_lifetime_);
  if(loop_){Lock lock(loop_);signal();}
}
void PipewireOutput::signal() noexcept {if(loop_)pw_thread_loop_signal(loop_,false);}
void PipewireOutput::failure(int error) noexcept {error_=error;signal();if(completion_event_)completed(this);}
void PipewireOutput::open(){
  if(loop_ || closed_)throw ProtocolError("output already opened or retired");
  static std::once_flag initialized;std::call_once(initialized,[]{pw_init(nullptr,nullptr);});
  check();
  {std::lock_guard<std::mutex> lifetime(loop_lifetime_);loop_=pw_thread_loop_new("mtai-avatar-output",nullptr);}
  if(!loop_)throw std::bad_alloc();
  auto* main=pw_thread_loop_get_loop(loop_);
  completion_event_=pw_loop_add_event(main,event,this);if(!completion_event_)throw std::runtime_error("PipeWire completion event failed");
  custody_=std::make_unique<PcmCustody>(target_,layout_.channels,[this](auto command,void* data){barrier(command,data);},completed,this);
  stream_=pw_stream_new_simple(main,"mtai-avatar-output",pw_properties_new(
    PW_KEY_MEDIA_TYPE,"Audio",PW_KEY_MEDIA_CATEGORY,"Playback",PW_KEY_MEDIA_ROLE,"Communication",nullptr),&callbacks_,this);
  if(!stream_)throw std::runtime_error("PipeWire output allocation failed");
  checked(pw_thread_loop_start(loop_),"start PipeWire output loop");started_=true;
  Lock lock(loop_);
  uint8_t storage[1024];spa_pod_builder builder{};spa_pod_builder_init(&builder,storage,sizeof(storage));
  spa_audio_info_raw info{};info.format=SPA_AUDIO_FORMAT_S16_LE;info.rate=layout_.sample_rate;
  info.channels=layout_.channels;info.flags=SPA_AUDIO_FLAG_UNPOSITIONED;
  const spa_pod* parameters[]={spa_format_audio_raw_build(&builder,SPA_PARAM_EnumFormat,&info)};
  checked(pw_stream_connect(stream_,PW_DIRECTION_OUTPUT,PW_ID_ANY,
    pw_stream_flags(PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS|PW_STREAM_FLAG_RT_PROCESS),parameters,1),"connect PipeWire output");
  connected_=true;
  while(true){check();if(format_ready_ && usable_buffers_ && (state_==PW_STREAM_STATE_PAUSED || state_==PW_STREAM_STATE_STREAMING))break;pw_thread_loop_wait(loop_);}
  opened_=true;
}
int PipewireOutput::invoked(spa_loop*,bool,uint32_t,const void* data,size_t,void*) noexcept {
  const auto& invocation=*static_cast<const Invocation*>(data);invocation.command(invocation.data);return 0;
}
void PipewireOutput::barrier(PcmCustody::Command command,void* data){
  if(!connected_){command(data);return;}
  Lock lock(loop_);
  auto* processing=stream_?pw_stream_get_data_loop(stream_):nullptr;
  if(!processing)throw ProtocolError("connected PipeWire stream lacks processing loop");
  Invocation invocation{command,data};
  checked(pw_loop_invoke(processing,invoked,0,&invocation,sizeof(invocation),true,nullptr),"PipeWire RT barrier");
}
void PipewireOutput::completed(void* data) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);
  int status=pw_loop_signal_event(pw_thread_loop_get_loop(self.loop_),self.completion_event_);
  if(status<0)self.error_=status;
}
void PipewireOutput::event(void* data,uint64_t) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);self.signal();self.notify_(self.notify_data_);
}
void PipewireOutput::state(void* data,pw_stream_state,pw_stream_state value,const char*) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);self.state_=value;
  if(value==PW_STREAM_STATE_ERROR || (value==PW_STREAM_STATE_UNCONNECTED && self.connected_))self.failure(-EIO);
  self.signal();
}
void PipewireOutput::format(void* data,uint32_t id,const spa_pod* value) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);if(id!=SPA_PARAM_Format)return;
  spa_audio_info_raw info{};uint32_t type=0,subtype=0;
  if(!value || spa_format_parse(value,&type,&subtype)<0 || type!=SPA_MEDIA_TYPE_audio || subtype!=SPA_MEDIA_SUBTYPE_raw
      || spa_format_audio_raw_parse(value,&info)<0 || info.format!=SPA_AUDIO_FORMAT_S16_LE
      || info.rate!=self.layout_.sample_rate || info.channels!=self.layout_.channels)self.failure(-EINVAL);
  else self.format_ready_=true;
  self.signal();
}
void PipewireOutput::accept_buffer(pw_buffer* buffer){
  auto* spa=buffer->buffer;bool usable=spa && spa->n_datas==1 && spa->datas[0].data && spa->datas[0].chunk
    && spa->datas[0].maxsize>=size_t(layout_.channels)*2;
  auto* info=new BufferInfo{usable};buffer->user_data=info;
  if(usable)++usable_buffers_;else failure(-EINVAL);
  signal();
}
void PipewireOutput::added(void* data,pw_buffer* buffer) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);
  try{self.accept_buffer(buffer);}catch(...){self.failure(-ENOMEM);}
}
void PipewireOutput::removed(void* data,pw_buffer* buffer) noexcept {
  auto& self=*static_cast<PipewireOutput*>(data);auto* info=static_cast<BufferInfo*>(buffer->user_data);
  if(info){if(info->usable)--self.usable_buffers_;delete info;buffer->user_data=nullptr;}self.signal();
}
void PipewireOutput::processing(void* data) noexcept {static_cast<PipewireOutput*>(data)->process();}
void PipewireOutput::process() noexcept {
  auto* buffer=pw_stream_dequeue_buffer(stream_);if(!buffer)return;
  auto* info=static_cast<BufferInfo*>(buffer->user_data);
  size_t bytes=0;
  if(info && info->usable){auto& plane=buffer->buffer->datas[0];bytes=custody_->process(static_cast<uint8_t*>(plane.data),plane.maxsize,buffer->requested);
    plane.chunk->offset=0;plane.chunk->stride=layout_.channels*2;plane.chunk->size=bytes;}
  else {
    // Rejected storage must not carry a stale payload description downstream.
    if(buffer->buffer)for(uint32_t i=0;i<buffer->buffer->n_datas;++i)
      if(auto* chunk=buffer->buffer->datas[i].chunk){chunk->offset=0;chunk->size=0;}
    error_=-EINVAL;completed(this);
  }
  buffer->size=bytes/(size_t(layout_.channels)*2);
  int status=pw_stream_queue_buffer(stream_,buffer);if(status<0){error_=status;completed(this);}
}
void PipewireOutput::drained(void* data) noexcept {auto& self=*static_cast<PipewireOutput*>(data);self.drained_=true;self.signal();self.notify_(self.notify_data_);}
void PipewireOutput::submit(ResolvedFrame frame){if(!opened_ || ended_ || closed_)throw ProtocolError("output not accepting PCM");check();custody_->submit(std::move(frame));}
std::vector<PcmCompletion> PipewireOutput::collect(){check();return custody_?custody_->collect():std::vector<PcmCompletion>{};}
void PipewireOutput::wait_paused(){while(true){check();if(state_==PW_STREAM_STATE_PAUSED)return;pw_thread_loop_wait(loop_);}}
void PipewireOutput::stop(const Target& target,const std::string& turn){
  if(!opened_ || closed_)throw ProtocolError("stop without live output");
  check();custody_->begin_stop(target,turn);
  if(custody_->whole_stream_flush_permitted()){
    Lock lock(loop_);checked(pw_stream_set_active(stream_,false),"pause output for scoped stop");wait_paused();
    // A cancelled-only stream reset replaces any pending whole-stream drain.
    // Protected/unknown handed PCM never enters this branch.
    drain_started_=false;drained_=false;
    checked(pw_stream_flush(stream_,false),"flush cancelled-only output");custody_->stream_reset_completed();
    checked(pw_stream_set_active(stream_,true),"resume output after stop");
  }
  custody_->resume();
}
void PipewireOutput::begin_end(){
  if(!opened_ || closed_ || ended_)throw ProtocolError("invalid output EOS");
  check();ended_=true;custody_->end();
}
bool PipewireOutput::advance_drain(){
  if(!ended_ || closed_)throw ProtocolError("drain without output EOS");
  check();
  if(!custody_->handoff_complete())return false;
  Lock lock(loop_);check();
  if(!drain_started_){
    drained_=false;drain_started_=true;
    checked(pw_stream_flush(stream_,true),"drain output");
  }
  check();return drained_;
}
void PipewireOutput::end_and_drain(){
  begin_end();
  Lock lock(loop_);
  while(!advance_drain())pw_thread_loop_wait(loop_);
}
void PipewireOutput::close(){
  if(closed_)return;
  ended_=true;
  if(custody_)custody_->close();
  if(loop_){
    {Lock lock(loop_);if(stream_){if(connected_)checked(pw_stream_disconnect(stream_),"disconnect output");connected_=false;pw_stream_destroy(stream_);stream_=nullptr;}
      if(completion_event_){pw_loop_destroy_source(pw_thread_loop_get_loop(loop_),completion_event_);completion_event_=nullptr;}}
    if(started_){pw_thread_loop_stop(loop_);started_=false;}
    {std::lock_guard<std::mutex> lifetime(loop_lifetime_);pw_thread_loop_destroy(loop_);loop_=nullptr;}
  }
  custody_.reset();closed_=true;
}
}  // namespace mtai::avatar

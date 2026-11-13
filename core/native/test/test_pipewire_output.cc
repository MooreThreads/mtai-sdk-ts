#include "../pipewire_output.h"
#include <spa/param/audio/format-utils.h>
#include <cassert>
#include <condition_variable>
#include <cstring>
#include <iostream>
#include <mutex>
#include <thread>
#include <cstdlib>
#include <new>

thread_local bool in_process=false;
thread_local unsigned pw_lock_depth=0;
std::atomic<unsigned> process_allocations{0},process_frees{0};
void* operator new(std::size_t size){if(in_process)++process_allocations;if(auto* p=std::malloc(size?size:1))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{if(in_process && p)++process_frees;std::free(p);}
void operator delete(void* p,std::size_t) noexcept{::operator delete(p);}
void* operator new[](std::size_t size){return ::operator new(size);}
void operator delete[](void* p) noexcept{::operator delete(p);}
void operator delete[](void* p,std::size_t) noexcept{::operator delete(p);}

using namespace mtai::avatar;
struct pw_thread_loop {
  std::recursive_mutex mutex;std::condition_variable_any changed;
  pw_loop loop{};spa_loop spa{};spa_loop_utils utils{};spa_source source{};
  spa_source_event_func_t event=nullptr;void* event_data=nullptr;
  std::atomic<bool> event_pending{false};bool stopped=false;
};
struct pw_stream {
  pw_thread_loop* owner;const pw_stream_events* events;void* data;
  uint8_t bytes[12]{};spa_chunk chunk{};spa_data plane{};spa_buffer spa{};pw_buffer buffer{};
  bool dequeuable=false,buffer_added=false;
};
namespace {
std::mutex setup_mutex;std::condition_variable setup_changed;
pw_stream* current=nullptr;bool connected=false,hold_buffer=false,bad_format=false,hold_pause=false,hold_drain=false;
unsigned barrier_count=0,flushes=0,drains=0,destroys=0,stops=0;std::atomic<unsigned> notifications{0};
std::atomic<bool> pause_requested{false},drain_requested{false};bool fail_disconnect=false;
unsigned invalid_media=0;bool unusable_buffer=false;
uint32_t queued_chunk_size=0,queued_chunk_offset=0;
std::mutex rt_mutex;
int invoke(void*,spa_invoke_func_t function,uint32_t seq,const void* data,size_t size,bool block,void* user) {
  assert(block);std::lock_guard<std::mutex> lock(rt_mutex);++barrier_count;
  return function(nullptr,false,seq,data,size,user);
}
spa_source* add_event(void* object,spa_source_event_func_t function,void* data) {
  auto* loop=static_cast<pw_thread_loop*>(object);loop->event=function;loop->event_data=data;return &loop->source;
}
int signal_event(void* object,spa_source*) {auto* loop=static_cast<pw_thread_loop*>(object);loop->event_pending=true;return 0;}
void destroy_source(void*,spa_source*){}
spa_loop_methods loop_methods{};spa_loop_utils_methods utils_methods{};
void notify(void*) noexcept {++notifications;}
void add_buffer(pw_stream* stream) {
  stream->events->add_buffer(stream->data,&stream->buffer);stream->buffer_added=true;
}
void pump(pw_stream* stream) {
  std::lock_guard<std::recursive_mutex> lock(stream->owner->mutex);
  if(stream->owner->event_pending.exchange(false))stream->owner->event(stream->owner->event_data,1);
}
size_t process(pw_stream* stream,uint64_t requested) {
  {std::lock_guard<std::mutex> lock(rt_mutex);stream->buffer.requested=requested;stream->dequeuable=true;in_process=true;stream->events->process(stream->data);in_process=false;}
  pump(stream);return stream->chunk.size;
}
void reset() {std::lock_guard<std::mutex> lock(setup_mutex);current=nullptr;connected=false;hold_buffer=false;bad_format=false;hold_pause=false;hold_drain=false;barrier_count=flushes=drains=destroys=stops=0;notifications=0;pause_requested=false;drain_requested=false;fail_disconnect=false;invalid_media=0;unusable_buffer=false;queued_chunk_size=queued_chunk_offset=0;}
Target target{"session","generation","attachment"};
Layout layout(){Layout p;p.allocation=7;p.width=4;p.height=4;p.fourcc=0x34324241;p.stride=16;p.extent=64;p.row_origin=1;p.color_space=1;p.sample_rate=16000;p.channels=1;p.sample_format=1;return p;}
ResolvedFrame frame(uint64_t sequence,const std::string& turn,std::vector<uint8_t> pcm){auto count=pcm.size()/2;return {target,Frame{sequence,7,sequence,0,0,count,std::move(pcm)},EffectiveState{turn,true},PhaseDecision{}};}
}
extern "C" {
void pw_init(int*,char***){}
pw_thread_loop* pw_thread_loop_new(const char*,const spa_dict*) {
  auto* loop=new pw_thread_loop;
  loop_methods.invoke=invoke;utils_methods.add_event=add_event;utils_methods.signal_event=signal_event;utils_methods.destroy_source=destroy_source;
  loop->spa.iface=SPA_INTERFACE_INIT(SPA_TYPE_INTERFACE_Loop,0,&loop_methods,loop);
  loop->utils.iface=SPA_INTERFACE_INIT(SPA_TYPE_INTERFACE_LoopUtils,0,&utils_methods,loop);
  loop->loop.loop=&loop->spa;loop->loop.utils=&loop->utils;return loop;
}
pw_loop* pw_thread_loop_get_loop(pw_thread_loop* loop){return &loop->loop;}
int pw_thread_loop_start(pw_thread_loop*){return 0;}
void pw_thread_loop_stop(pw_thread_loop* loop){assert(!loop->stopped);loop->stopped=true;++stops;}
void pw_thread_loop_destroy(pw_thread_loop* loop){delete loop;}
void pw_thread_loop_lock(pw_thread_loop* loop){loop->mutex.lock();++pw_lock_depth;}
void pw_thread_loop_unlock(pw_thread_loop* loop){assert(pw_lock_depth);--pw_lock_depth;loop->mutex.unlock();}
void pw_thread_loop_wait(pw_thread_loop* loop){loop->changed.wait(loop->mutex);}
void pw_thread_loop_signal(pw_thread_loop* loop,bool){loop->changed.notify_all();}
pw_stream* pw_stream_new_simple(pw_loop* loop,const char*,pw_properties* props,const pw_stream_events* events,void* data) {
  pw_properties_free(props);auto* stream=new pw_stream;
  stream->owner=static_cast<pw_thread_loop*>(loop->loop->iface.cb.data);stream->events=events;stream->data=data;
  stream->plane.data=stream->bytes;stream->plane.maxsize=sizeof(stream->bytes);stream->plane.chunk=&stream->chunk;
  stream->spa.n_datas=1;stream->spa.datas=&stream->plane;stream->buffer.buffer=&stream->spa;return stream;
}
int pw_stream_connect(pw_stream* stream,pw_direction direction,uint32_t id,pw_stream_flags flags,const spa_pod** params,uint32_t count){
  assert(direction==PW_DIRECTION_OUTPUT && id==PW_ID_ANY);
  assert(flags==(PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS|PW_STREAM_FLAG_RT_PROCESS));assert(count==1);
  spa_audio_info_raw info{};assert(spa_format_audio_raw_parse(params[0],&info)>=0);assert(info.format==SPA_AUDIO_FORMAT_S16_LE && info.rate==16000 && info.channels==1);
  uint8_t storage[1024];spa_pod_builder builder{};spa_pod_builder_init(&builder,storage,sizeof(storage));if(bad_format)info.rate=48000;
  auto* negotiated=spa_format_audio_raw_build(&builder,SPA_PARAM_Format,&info);
  if(invalid_media) {
    auto* property=spa_pod_find_prop(negotiated,nullptr,invalid_media==1?SPA_FORMAT_mediaType:SPA_FORMAT_mediaSubtype);
    assert(property);*static_cast<uint32_t*>(SPA_POD_BODY(&property->value))=invalid_media==1?uint32_t(SPA_MEDIA_TYPE_video):uint32_t(SPA_MEDIA_SUBTYPE_mp3);
  }
  stream->events->param_changed(stream->data,SPA_PARAM_Format,negotiated);
  stream->events->state_changed(stream->data,PW_STREAM_STATE_CONNECTING,PW_STREAM_STATE_PAUSED,nullptr);
  if(unusable_buffer){stream->plane.data=nullptr;stream->chunk.size=8;stream->chunk.offset=2;}
  if(!hold_buffer)add_buffer(stream);
  {std::lock_guard<std::mutex> lock(setup_mutex);current=stream;connected=true;}setup_changed.notify_all();return 0;
}
pw_loop* pw_stream_get_data_loop(pw_stream* stream){assert(pw_lock_depth);return &stream->owner->loop;}
pw_buffer* pw_stream_dequeue_buffer(pw_stream* stream){if(!stream->dequeuable)return nullptr;stream->dequeuable=false;return &stream->buffer;}
int pw_stream_queue_buffer(pw_stream* stream,pw_buffer*){queued_chunk_size=stream->chunk.size;queued_chunk_offset=stream->chunk.offset;return 0;}
int pw_stream_set_active(pw_stream* stream,bool active){
  if(!active && hold_pause){pause_requested=true;return 0;}
  stream->events->state_changed(stream->data,PW_STREAM_STATE_STREAMING,active?PW_STREAM_STATE_STREAMING:PW_STREAM_STATE_PAUSED,nullptr);return 0;
}
int pw_stream_flush(pw_stream* stream,bool drain){if(drain){++drains;drain_requested=true;if(!hold_drain)stream->events->drained(stream->data);}else ++flushes;return 0;}
int pw_stream_disconnect(pw_stream*){return fail_disconnect?-EIO:0;}
void pw_stream_destroy(pw_stream* stream){if(stream->buffer_added)stream->events->remove_buffer(stream->data,&stream->buffer);++destroys;delete stream;}
}
void acceptance_and_output(){
  reset();hold_buffer=true;PipewireOutput output(target,layout(),notify,nullptr);std::atomic<bool> ready{false};
  std::thread worker([&]{output.open();ready=true;});
  {std::unique_lock<std::mutex> lock(setup_mutex);setup_changed.wait(lock,[]{return connected;});}
  assert(!ready);{std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);add_buffer(current);}worker.join();assert(ready);
  output.submit(frame(1,"A1",{1,2,3,4,5,6}));output.submit(frame(2,"B2",{7,8,9,10}));
  assert(process(current,2)==4);assert(std::memcmp(current->bytes,"\1\2\3\4",4)==0);output.stop(target,"A1");assert(flushes==1);
  assert(process(current,1)==2);assert(current->bytes[0]==7 && current->bytes[1]==8);
  output.stop(target,"A1");assert(flushes==1); // B already downstream forbids global flush
  assert(process(current,0)==2);assert(current->bytes[0]==9 && current->bytes[1]==10);
  auto complete=output.collect();assert(complete.size()==2 && complete[0].disposition==PcmDisposition::cancelled && complete[1].identity.turn=="B2");
  output.end_and_drain();assert(drains==1 && barrier_count>0);output.close();output.close();assert(destroys==1 && stops==1);
}
void failed_format(){reset();bad_format=true;PipewireOutput output(target,layout(),notify,nullptr);bool failed=false;try{output.open();}catch(const std::exception&){failed=true;}assert(failed);output.close();assert(destroys==1 && stops==1);}
void delayed_pause_and_drain(){
  reset();PipewireOutput output(target,layout(),notify,nullptr);output.open();
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);current->events->state_changed(current->data,PW_STREAM_STATE_PAUSED,PW_STREAM_STATE_STREAMING,nullptr);}
  output.submit(frame(1,"A1",{1,2,3,4}));assert(process(current,1)==2);
  hold_pause=true;std::atomic<bool> stopped{false};
  std::thread stopping([&]{output.stop(target,"A1");stopped=true;});
  while(!pause_requested.load())std::this_thread::yield();
  assert(!stopped && flushes==0); // no flush without observed PAUSED
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);current->events->state_changed(current->data,PW_STREAM_STATE_STREAMING,PW_STREAM_STATE_PAUSED,nullptr);}
  stopping.join();assert(stopped && flushes==1);
  output.submit(frame(2,"B2",{5,6,7,8}));hold_drain=true;std::atomic<bool> finished{false};
  std::thread draining([&]{output.end_and_drain();finished=true;});
  assert(process(current,1)==2);assert(!drain_requested && !finished);
  assert(process(current,1)==2);
  while(!drain_requested.load())std::this_thread::yield();
  assert(!finished);
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);current->events->drained(current->data);}
  draining.join();assert(finished && drains==1);output.close();
}
void failed_close_retry(){
  reset();PipewireOutput output(target,layout(),notify,nullptr);output.open();fail_disconnect=true;
  bool failed=false;try{output.close();}catch(const std::exception&){failed=true;}
  assert(failed && destroys==0 && stops==0);fail_disconnect=false;output.close();assert(destroys==1 && stops==1);
}
void idle_error(){
  reset();PipewireOutput output(target,layout(),notify,nullptr);output.open();
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);current->events->state_changed(current->data,PW_STREAM_STATE_PAUSED,PW_STREAM_STATE_ERROR,"idle failure");}
  pump(current);assert(notifications>0);bool failed=false;try{output.collect();}catch(const std::exception&){failed=true;}assert(failed);output.close();
}
void error_with_success(bool draining){
  reset();PipewireOutput output(target,layout(),notify,nullptr);output.open();
  std::atomic<bool> failed{false},succeeded{false};
  if(draining)hold_drain=true;
  else {
    hold_pause=true;
    std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);current->events->state_changed(current->data,PW_STREAM_STATE_PAUSED,PW_STREAM_STATE_STREAMING,nullptr);
  }
  std::thread worker([&]{try{if(draining)output.end_and_drain();else output.stop(target,"A1");succeeded=true;}catch(const std::exception&){failed=true;}});
  while(!(draining?drain_requested.load():pause_requested.load()))std::this_thread::yield();
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);
    current->events->state_changed(current->data,PW_STREAM_STATE_STREAMING,PW_STREAM_STATE_ERROR,"combined failure");
    if(draining)current->events->drained(current->data);
    else current->events->state_changed(current->data,PW_STREAM_STATE_ERROR,PW_STREAM_STATE_PAUSED,nullptr);
  }
  worker.join();assert(failed && !succeeded);if(!draining)assert(flushes==0);output.close();
}
void wrong_media(unsigned variant){reset();invalid_media=variant;PipewireOutput output(target,layout(),notify,nullptr);bool failed=false;try{output.open();}catch(const std::exception&){failed=true;}assert(failed);output.close();}
void rejected_storage(){
  reset();unusable_buffer=true;PipewireOutput rejected(target,layout(),notify,nullptr);
  bool failed=false;try{rejected.open();}catch(const std::exception&){failed=true;}
  assert(failed);pump(current);assert(notifications>0);rejected.close();assert(destroys==1 && stops==1);
  reset();PipewireOutput output(target,layout(),notify,nullptr);output.open();
  {std::lock_guard<std::recursive_mutex> lock(current->owner->mutex);
    current->events->remove_buffer(current->data,&current->buffer);current->buffer_added=false;
    current->plane.data=nullptr;current->chunk.size=8;current->chunk.offset=2;add_buffer(current);
  }
  assert(process(current,1)==0);assert(queued_chunk_size==0 && queued_chunk_offset==0 && current->buffer.size==0);
  failed=false;try{output.collect();}catch(const std::exception&){failed=true;}assert(failed);output.close();
}
int main(){acceptance_and_output();failed_format();delayed_pause_and_drain();failed_close_retry();idle_error();error_with_success(false);error_with_success(true);wrong_media(1);wrong_media(2);rejected_storage();assert(process_allocations==0 && process_frees==0);std::cout<<"PipeWire adapter fake API negotiation/bytes/scoped stop/drain/close passed\n";}

#include "async_playback.h"
#include "local_media_protocol.h"
#include <node_api.h>
#include <cstring>
#include <memory>
#include <list>

#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
extern "C" void mtai_install_fixture(napi_env,napi_value);
extern "C" void mtai_install_connection_fixture(napi_env,napi_value);
#endif
namespace mtai::avatar {
void install_node_connection(napi_env,napi_value);
namespace {
void checked(napi_status status){if(status!=napi_ok)throw std::runtime_error("Node-API call failed");}
struct HandleScope {
  napi_env env;napi_handle_scope scope=nullptr;
  explicit HandleScope(napi_env value):env(value){checked(napi_open_handle_scope(env,&scope));}
  ~HandleScope(){if(scope)napi_close_handle_scope(env,scope);}
};
struct CallbackScope {
  napi_env env;napi_callback_scope scope=nullptr;
  CallbackScope(napi_env value,napi_value resource,napi_async_context context):env(value){checked(napi_open_callback_scope(env,resource,context,&scope));}
  ~CallbackScope(){if(scope)napi_close_callback_scope(env,scope);}
};
napi_value undefined(napi_env env){napi_value value;checked(napi_get_undefined(env,&value));return value;}
napi_value text(napi_env env,const std::string& value){napi_value result;checked(napi_create_string_utf8(env,value.data(),value.size(),&result));return result;}
void property(napi_env env,napi_value object,const char* name,napi_value value){checked(napi_set_named_property(env,object,name,value));}
void integer(napi_env env,napi_value object,const char* name,uint64_t value){napi_value result;checked(napi_create_bigint_uint64(env,value,&result));property(env,object,name,result);}
std::string string(napi_env env,napi_value value){
  napi_valuetype type;checked(napi_typeof(env,value,&type));if(type!=napi_string)throw ProtocolError("string required");
  size_t length;checked(napi_get_value_string_utf8(env,value,nullptr,0,&length));std::string output(length+1,'\0');
  checked(napi_get_value_string_utf8(env,value,output.data(),output.size(),&length));output.resize(length);return output;
}
bool actual_buffer(napi_env env,napi_value value){
  napi_value global,constructor,predicate,result;checked(napi_get_global(env,&global));checked(napi_get_named_property(env,global,"Buffer",&constructor));
  checked(napi_get_named_property(env,constructor,"isBuffer",&predicate));checked(napi_call_function(env,constructor,predicate,1,&value,&result));
  bool buffer=false;checked(napi_get_value_bool(env,result,&buffer));return buffer;
}
Record wire(napi_env env,napi_value value,napi_ref predicate=nullptr){
  bool buffer=false;
  if(predicate){napi_value function,global,result;checked(napi_get_reference_value(env,predicate,&function));checked(napi_get_global(env,&global));checked(napi_call_function(env,global,function,1,&value,&result));checked(napi_get_value_bool(env,result,&buffer));}
  else buffer=actual_buffer(env,value);
  if(!buffer)throw ProtocolError("wire Buffer required");
  void* data;size_t size;checked(napi_get_buffer_info(env,value,&data,&size));std::vector<uint8_t> bytes(size);
  if(size)std::memcpy(bytes.data(),data,size);
  return decode(bytes);
}
struct NodePlayback : std::enable_shared_from_this<NodePlayback> {
  napi_env env;napi_ref callback=nullptr,resource=nullptr,buffer_predicate=nullptr;napi_async_context context=nullptr;napi_async_cleanup_hook_handle hook=nullptr;
  Target target;Layout layout;std::shared_ptr<AsyncPlayback> playback;
  std::shared_ptr<NodePlayback> keepalive;
  std::list<napi_deferred> closes;
  bool cleanup=false,closed=false,closing=false,reporting=false;
  NodePlayback(napi_env e,Target t,Layout l):env(e),target(std::move(t)),layout(l){}
  void emit(napi_value event){
    if(cleanup || !callback || closing)return;
    napi_value function,global,result;checked(napi_get_reference_value(env,callback,&function));checked(napi_get_global(env,&global));
    napi_status status=napi_make_callback(env,context,global,function,1,&event,&result);
    if(status==napi_pending_exception){napi_value exception;checked(napi_get_and_clear_last_exception(env,&exception));
      throw ProtocolError("avatar playback callback threw");}
    checked(status);
  }
  napi_value event(const char* type){napi_value value;checked(napi_create_object(env,&value));property(env,value,"type",text(env,type));return value;}
  void settle(napi_value error=nullptr){
    std::list<napi_deferred> batch;batch.splice(batch.end(),closes);
    try{
      while(!batch.empty()){
        checked(error?napi_reject_deferred(env,batch.front(),error):napi_resolve_deferred(env,batch.front(),undefined(env)));
        batch.pop_front();
      }
    }catch(...){closes.splice(closes.begin(),batch);throw;}
  }
  void failure(const std::string& message){
    if(cleanup)return;
    HandleScope scope(env);
    napi_value held;checked(napi_get_reference_value(env,resource,&held));CallbackScope callback_scope(env,held,context);
    auto error=text(env,message);
    settle(error);
    // Reporting failure may not initiate an automatic native retirement retry.
    if(callback && !reporting){reporting=true;
      auto value=event("failed");property(env,value,"message",error);
      napi_value function,global,result;checked(napi_get_reference_value(env,callback,&function));checked(napi_get_global(env,&global));
      auto status=napi_make_callback(env,context,global,function,1,&value,&result);
      if(status==napi_pending_exception){napi_value exception;napi_get_and_clear_last_exception(env,&exception);}
      reporting=false;
    }
  }
  template<class Function> void dispatch(Function function){
    if(cleanup)return;
    HandleScope scope(env);
    napi_value held;checked(napi_get_reference_value(env,resource,&held));
    CallbackScope callback_scope(env,held,context);
    try{function();}catch(...){closing=true;throw;}
  }
  void retired(){
    closed=true;playback.reset();
    if(!cleanup){HandleScope scope(env);
      napi_value held;checked(napi_get_reference_value(env,resource,&held));
      {CallbackScope callback_scope(env,held,context);
        settle();
      }
      if(callback){checked(napi_delete_reference(env,callback));callback=nullptr;}
      if(buffer_predicate){checked(napi_delete_reference(env,buffer_predicate));buffer_predicate=nullptr;}
      if(context){checked(napi_async_destroy(env,context));context=nullptr;}
      if(resource){checked(napi_delete_reference(env,resource));resource=nullptr;}
    }
    if(hook){auto owned=hook;hook=nullptr;checked(napi_remove_async_cleanup_hook(owned));}
    auto lifetime=std::move(keepalive);
  }
  static void cleaning(napi_async_cleanup_hook_handle,void* data){
    auto& self=*static_cast<NodePlayback*>(data);self.cleanup=true;self.closing=true;
    // Environment owns reference disposal during teardown; no NAPI/V8 work
    // after cleanup begins other than completing the async cleanup hook.
    if(self.context){napi_async_destroy(self.env,self.context);self.context=nullptr;}
    self.callback=nullptr;self.resource=nullptr;self.buffer_predicate=nullptr;
    if(self.closed)self.retired();else if(self.playback)self.playback->close();
  }
};
using Holder=std::shared_ptr<NodePlayback>;
void finalized(napi_env,void* data,void*){delete static_cast<Holder*>(data);}
Holder owner(napi_env env,napi_callback_info info,size_t& count,napi_value* arguments){
  napi_value self;checked(napi_get_cb_info(env,info,&count,arguments,&self,nullptr));void* data;
  checked(napi_unwrap(env,self,&data));return *static_cast<Holder*>(data);
}
template<class Function> napi_value guarded(napi_env env,Function function){
  try{return function();}catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}
}
napi_value submit(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=2;napi_value args[2];auto self=owner(env,info,count,args);if(count!=2)throw ProtocolError("frame and effective-state Buffers required");
  if(self->closing || self->closed)throw ProtocolError("playback closed");
  auto record=wire(env,args[0],self->buffer_predicate),state=wire(env,args[1],self->buffer_predicate);auto* frame=std::get_if<Frame>(&record.payload);auto* effective=std::get_if<OutputState>(&state.payload);
  if(!frame || !effective || !(record.target==self->target) || !(state.target==self->target)
     || frame->allocation!=self->layout.allocation || effective->effective_frame!=frame->sequence)throw ProtocolError("unmatched eligible PCM/state");
  self->playback->submit(ResolvedFrame{self->target,std::move(*frame),EffectiveState{effective->turn,effective->audio_active},PhaseDecision{}});
  return undefined(env);
});}
napi_value stop(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=4;napi_value args[4];auto self=owner(env,info,count,args);if(count!=4)throw ProtocolError("captured target and turn required");
  if(self->closing || self->closed)throw ProtocolError("playback closed");
  Target target{string(env,args[0]),string(env,args[1]),string(env,args[2])};self->playback->stop(std::move(target),string(env,args[3]));return undefined(env);
});}
napi_value end(napi_env env,napi_callback_info info){return guarded(env,[&]{size_t count=0;auto self=owner(env,info,count,nullptr);
  if(self->closing || self->closed)throw ProtocolError("playback closed");
  self->playback->end();return undefined(env);
});}
napi_value close(napi_env env,napi_callback_info info){return guarded(env,[&]{size_t count=0;auto self=owner(env,info,count,nullptr);
  // A real owner-held node precedes Promise init hooks, which can reenter close.
  auto slot=self->closes.emplace(self->closes.end(),nullptr);
  napi_value promise;
  if(!self->closed){self->closing=true;self->playback->close();}
  try{checked(napi_create_promise(env,&*slot,&promise));}catch(...){self->closes.erase(slot);throw;}
  if(self->closed){auto deferred=*slot;self->closes.erase(slot);checked(napi_resolve_deferred(env,deferred,undefined(env)));}
  return promise;
});}
napi_value create(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=2;napi_value args[2];checked(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));if(count!=2)throw ProtocolError("layout Buffer and callback required");
  auto record=wire(env,args[0]);auto* layout=std::get_if<Layout>(&record.payload);if(!layout)throw ProtocolError("LAYOUT required");validate_layout(*layout);
  napi_valuetype type;checked(napi_typeof(env,args[1],&type));if(type!=napi_function)throw ProtocolError("callback required");
  auto self=std::make_shared<NodePlayback>(env,std::move(record.target),*layout);
  napi_value object;checked(napi_create_object(env,&object));auto holder=std::make_unique<Holder>(self);
  checked(napi_wrap(env,object,holder.get(),finalized,nullptr,nullptr));holder.release();
  napi_property_descriptor methods[]={
    {"submitEligible",nullptr,submit,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stop",nullptr,stop,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"end",nullptr,end,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,close,nullptr,nullptr,nullptr,napi_default,nullptr}};
  checked(napi_define_properties(env,object,4,methods));
  try{
    checked(napi_create_reference(env,args[1],1,&self->callback));
    napi_value global,buffer,predicate;checked(napi_get_global(env,&global));checked(napi_get_named_property(env,global,"Buffer",&buffer));checked(napi_get_named_property(env,buffer,"isBuffer",&predicate));checked(napi_create_reference(env,predicate,1,&self->buffer_predicate));
    napi_value resource;checked(napi_create_object(env,&resource));checked(napi_create_reference(env,resource,1,&self->resource));
    checked(napi_async_init(env,resource,text(env,"mtai.avatar.playback"),&self->context));
    checked(napi_add_async_cleanup_hook(env,NodePlayback::cleaning,self.get(),&self->hook));
    uv_loop_t* loop;checked(napi_get_uv_event_loop(env,&loop));self->keepalive=self;
    PlaybackEvents events;
    events.ready=[self]{auto* raw=self.get();raw->dispatch([&]{raw->emit(raw->event("audioReady"));});};
    events.drained=[self]{auto* raw=self.get();raw->dispatch([&]{raw->emit(raw->event("drained"));});};
    events.completed=[self](std::vector<PcmCompletion> values){auto* raw=self.get();raw->dispatch([&]{
      for(const auto& completion:values){if(raw->closing)break;auto value=raw->event("pcmCompleted");
        integer(raw->env,value,"sequence",completion.identity.sequence);integer(raw->env,value,"sampleStart",completion.identity.sample_start);integer(raw->env,value,"sampleCount",completion.identity.sample_count);
        property(raw->env,value,"turn",completion.identity.turn?text(raw->env,*completion.identity.turn):undefined(raw->env));
        property(raw->env,value,"disposition",text(raw->env,completion.disposition==PcmDisposition::copied?"copied":"cancelled"));raw->emit(value);
      }
    });};
    events.failed=[self](std::string message){auto* raw=self.get();raw->closing=true;raw->failure(message);};
    events.closed=[self]{self->retired();};
    self->playback=AsyncPlayback::open(loop,self->target,self->layout,std::move(events));
  }catch(...){if(self->hook){napi_remove_async_cleanup_hook(self->hook);self->hook=nullptr;}if(self->callback){napi_delete_reference(env,self->callback);self->callback=nullptr;}if(self->buffer_predicate){napi_delete_reference(env,self->buffer_predicate);self->buffer_predicate=nullptr;}if(self->context){napi_async_destroy(env,self->context);self->context=nullptr;}if(self->resource){napi_delete_reference(env,self->resource);self->resource=nullptr;}self->keepalive.reset();throw;}
  return object;
});}
napi_value initialize(napi_env env,napi_value exports){
 try{
  napi_value function;if(napi_create_function(env,"createPlayback",NAPI_AUTO_LENGTH,create,nullptr,&function)!=napi_ok)return nullptr;
  if(napi_set_named_property(env,exports,"createPlayback",function)!=napi_ok)return nullptr;
  install_node_connection(env,exports);
#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
  mtai_install_fixture(env,exports);
  mtai_install_connection_fixture(env,exports);
#endif
  return exports;
 }catch(const std::exception& error){bool pending=false;napi_is_exception_pending(env,&pending);if(!pending)napi_throw_error(env,nullptr,error.what());return nullptr;}
}
}
}  // namespace mtai::avatar
NAPI_MODULE(mtai_avatar_native,mtai::avatar::initialize)

#include "local_media_connection.h"
#include <node_api.h>
#include <fcntl.h>
#include <list>
#include <memory>
#include <cstring>
#include <cmath>
#include <system_error>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <time.h>

namespace mtai::avatar {
namespace {
void check(napi_status status){if(status!=napi_ok)throw std::runtime_error("Node connection API failed");}
struct Handles {napi_env env;napi_handle_scope scope;explicit Handles(napi_env e):env(e){check(napi_open_handle_scope(env,&scope));}~Handles(){napi_close_handle_scope(env,scope);}};
struct Callbacks {napi_env env;napi_callback_scope scope;Callbacks(napi_env e,napi_value resource,napi_async_context context):env(e){check(napi_open_callback_scope(env,resource,context,&scope));}~Callbacks(){napi_close_callback_scope(env,scope);}};
napi_value undef(napi_env env){napi_value v;check(napi_get_undefined(env,&v));return v;}
napi_value text(napi_env env,const std::string& value){napi_value v;check(napi_create_string_utf8(env,value.data(),value.size(),&v));return v;}
void prop(napi_env env,napi_value object,const char* key,napi_value value){check(napi_set_named_property(env,object,key,value));}
void big(napi_env env,napi_value object,const char* key,uint64_t value){napi_value v;check(napi_create_bigint_uint64(env,value,&v));prop(env,object,key,v);}
napi_value buffer(napi_env env,const Record& record){auto bytes=encode(record);napi_value v;check(napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&v));return v;}
Record decode_buffer(napi_env env,napi_value value,napi_value predicate){
  napi_value global,result;check(napi_get_global(env,&global));check(napi_call_function(env,global,predicate,1,&value,&result));
  bool valid=false;check(napi_get_value_bool(env,result,&valid));if(!valid)throw ProtocolError("wire Buffer required");
  void* data;size_t size;check(napi_get_buffer_info(env,value,&data,&size));std::vector<uint8_t> bytes(size);if(size)std::memcpy(bytes.data(),data,size);return decode(bytes);
}
struct NodeConnection {
  napi_env env;napi_ref callback=nullptr,resource=nullptr,predicate=nullptr;napi_async_context context=nullptr;
  napi_async_cleanup_hook_handle hook=nullptr;
  Target target;Descriptor allocation;std::shared_ptr<LocalConnection> connection;
  std::shared_ptr<NodeConnection> keepalive;std::list<napi_deferred> closes;
  uv_async_t activation{};bool activation_closed=false,adopting=false,native_closed=false;
  Descriptor socket;std::optional<std::string> startup_error;
  bool closing=false,closed=false,cleanup=false;
  NodeConnection(napi_env e,Target t):env(e),target(std::move(t)){}
  void dispose_refs(){
    if(context){check(napi_async_destroy(env,context));context=nullptr;}
    for(auto* ref:{&callback,&resource,&predicate})if(*ref){check(napi_delete_reference(env,*ref));*ref=nullptr;}
  }
  template<class Function> void scoped(Function function){
    if(cleanup)return;
    Handles handles(env);napi_value value;check(napi_get_reference_value(env,resource,&value));Callbacks callbacks(env,value,context);
    try{function();}catch(...){closing=true;throw;}
  }
  napi_value event(const char* type){napi_value v;check(napi_create_object(env,&v));prop(env,v,"type",text(env,type));return v;}
  void emit(napi_value event){
    if(cleanup || closing)return;
    napi_value function,global,result;check(napi_get_reference_value(env,callback,&function));check(napi_get_global(env,&global));
    auto status=napi_make_callback(env,context,global,function,1,&event,&result);
    if(status==napi_pending_exception){napi_value exception;check(napi_get_and_clear_last_exception(env,&exception));closing=true;throw ProtocolError("connection callback threw");}
    check(status);
  }
  Record wire(napi_value value){napi_value function;check(napi_get_reference_value(env,predicate,&function));return decode_buffer(env,value,function);}
  void settle(napi_value error=nullptr){
    std::list<napi_deferred> batch;batch.splice(batch.end(),closes);
    try{while(!batch.empty()){check(error?napi_reject_deferred(env,batch.front(),error):napi_resolve_deferred(env,batch.front(),undef(env)));batch.pop_front();}}
    catch(...){closes.splice(closes.begin(),batch);throw;}
  }
  void failure(const std::string& message){
    closing=true;if(cleanup)return;
    scoped([&]{auto value=event("failed");prop(env,value,"message",text(env,message));settle(text(env,message));
      napi_value function,global,result;check(napi_get_reference_value(env,callback,&function));check(napi_get_global(env,&global));
      auto status=napi_make_callback(env,context,global,function,1,&value,&result);
      if(status==napi_pending_exception){napi_value exception;check(napi_get_and_clear_last_exception(env,&exception));}
    });
  }
  void retired(){
    native_closed=true;if(adopting || !activation_closed)return;
    finish();
  }
  void finish(){
    closed=true;closing=true;allocation=Descriptor();connection.reset();
    if(!cleanup){scoped([&]{settle();});dispose_refs();}
    if(hook){auto owned=hook;hook=nullptr;check(napi_remove_async_cleanup_hook(owned));}
    auto lifetime=std::move(keepalive);
  }
  void request_close(){closing=true;if(connection)connection->close();}
  static void activated(uv_async_t* handle) noexcept;
  static void activation_retired(uv_handle_t* handle) noexcept {
    auto& self=*static_cast<NodeConnection*>(handle->data);self.activation_closed=true;
    try{if(self.native_closed)self.finish();}catch(...) {}
  }
  static void cleaning(napi_async_cleanup_hook_handle,void* data){
    auto& self=*static_cast<NodeConnection*>(data);self.cleanup=true;self.closing=true;
    if(self.context){napi_async_destroy(self.env,self.context);self.context=nullptr;}
    self.callback=self.resource=self.predicate=nullptr;
    if(self.closed)self.retired();else self.request_close();
  }
};
void NodeConnection::activated(uv_async_t* handle) noexcept {
  auto* self=static_cast<NodeConnection*>(handle->data);auto lifetime=self->keepalive;self->adopting=true;
  try{
    if(self->closing){self->socket=Descriptor();self->native_closed=true;}
    else {
      ConnectionEvents events;
      events.layout=[lifetime](Layout layout,Descriptor fd){auto* self=lifetime.get();self->allocation=std::move(fd);self->scoped([&]{auto value=self->event("layout");prop(self->env,value,"wire",buffer(self->env,{self->target,layout}));napi_value number;check(napi_create_int32(self->env,self->allocation.get(),&number));prop(self->env,value,"fd",number);self->emit(value);});};
      events.attached=[lifetime]{lifetime->scoped([&]{lifetime->emit(lifetime->event("attached"));});};
      events.eligible=[lifetime](ResolvedFrame frame){auto* self=lifetime.get();self->scoped([&]{auto value=self->event("eligible");prop(self->env,value,"frame",buffer(self->env,{frame.target,frame.frame}));prop(self->env,value,"state",buffer(self->env,{frame.target,OutputState{frame.frame.sequence,true,frame.state.turn,frame.state.audio_active}}));big(self->env,value,"deadlineNs",frame.phase.deadline_ns);big(self->env,value,"originNs",frame.phase.origin_ns);big(self->env,value,"initialOriginNs",frame.phase.initial_origin_ns);big(self->env,value,"revision",frame.phase.revision);self->emit(value);});};
      events.eos=[lifetime]{lifetime->scoped([&]{lifetime->emit(lifetime->event("eos"));});};
      events.failure=[lifetime](std::string message){if(lifetime->adopting)lifetime->startup_error=std::move(message);else lifetime->failure(message);};
      events.closed=[lifetime]{lifetime->retired();};
      self->connection=LocalConnection::open(handle->loop,std::move(self->socket),self->target,std::move(events));
    }
  }catch(const std::exception& error){self->startup_error=error.what();self->native_closed=true;}
  self->adopting=false;
  try{if(self->startup_error)self->failure(*self->startup_error);}catch(...) {}
  uv_close(reinterpret_cast<uv_handle_t*>(handle),activation_retired);
}
using Holder=std::shared_ptr<NodeConnection>;
// Allocation custody is independent of socket/uv retirement. The SDK main
// attachment retains this object until all texture imports/references retire.
struct AllocationLease {napi_env env;Descriptor descriptor;bool hooked=false;};
void lease_cleanup(void* data){auto* self=static_cast<AllocationLease*>(data);self->descriptor=Descriptor();self->hooked=false;}
void lease_finalized(napi_env,void* data,void*){auto* self=static_cast<AllocationLease*>(data);if(self->hooked)napi_remove_env_cleanup_hook(self->env,lease_cleanup,self);delete self;}
napi_value lease_close(napi_env env,napi_callback_info info){napi_value object;size_t count=0;void* data=nullptr;
  if(napi_get_cb_info(env,info,&count,nullptr,&object,nullptr)!=napi_ok || napi_unwrap(env,object,&data)!=napi_ok){napi_throw_error(env,nullptr,"allocation lease required");return nullptr;}
  auto* self=static_cast<AllocationLease*>(data);self->descriptor=Descriptor();if(self->hooked){napi_remove_env_cleanup_hook(env,lease_cleanup,self);self->hooked=false;}return undef(env);
}
void finalizer(napi_env,void* data,void*){delete static_cast<Holder*>(data);}
Holder owner(napi_env env,napi_callback_info info,size_t& count,napi_value* args){napi_value self;check(napi_get_cb_info(env,info,&count,args,&self,nullptr));void* data;check(napi_unwrap(env,self,&data));return *static_cast<Holder*>(data);}
template<class Function> napi_value guarded(napi_env env,Function function){try{return function();}catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}}
napi_value accept(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=1;napi_value args[1];auto self=owner(env,info,count,args);if(count!=1 || self->closing || !self->connection)throw ProtocolError("connection not accepting layout");
  uint64_t allocation;bool lossless=false;check(napi_get_value_bigint_uint64(env,args[0],&allocation,&lossless));if(!lossless)throw ProtocolError("allocation u64 required");
  self->connection->accept_layout(allocation);return undef(env);
});}
napi_value send(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=1;napi_value args[1];auto self=owner(env,info,count,args);if(count!=1 || self->closing)throw ProtocolError("connection closed");
  if(!self->connection)throw ProtocolError("connection not active");
  auto record=self->wire(args[0]);if(std::holds_alternative<Ready>(record.payload))throw ProtocolError("READY requires explicit acceptance");
  self->connection->send_control(std::move(record));return undef(env);
});}
napi_value close(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=0;auto self=owner(env,info,count,nullptr);auto slot=self->closes.emplace(self->closes.end(),nullptr);
  if(!self->closed)self->request_close();
  napi_value promise;try{check(napi_create_promise(env,&*slot,&promise));}catch(...){self->closes.erase(slot);throw;}
  if(self->closed){auto deferred=*slot;self->closes.erase(slot);check(napi_resolve_deferred(env,deferred,undef(env)));}return promise;
});}
napi_value retain_allocation(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=0;auto self=owner(env,info,count,nullptr);if(self->allocation.get()<0 || self->closing)throw ProtocolError("no live allocation");
  auto lease=std::make_unique<AllocationLease>();lease->env=env;lease->descriptor=Descriptor(fcntl(self->allocation.get(),F_DUPFD_CLOEXEC,0));
  if(lease->descriptor.get()<0)throw std::system_error(errno,std::generic_category(),"retain allocation");
  napi_value object,fd;check(napi_create_object(env,&object));check(napi_create_int32(env,lease->descriptor.get(),&fd));
  napi_property_descriptor properties[]={{"fd",nullptr,nullptr,nullptr,nullptr,fd,napi_enumerable,nullptr},{"close",nullptr,lease_close,nullptr,nullptr,nullptr,napi_default,nullptr}};
  check(napi_define_properties(env,object,2,properties));check(napi_add_env_cleanup_hook(env,lease_cleanup,lease.get()));lease->hooked=true;
  auto status=napi_wrap(env,object,lease.get(),lease_finalized,nullptr,nullptr);if(status!=napi_ok){napi_remove_env_cleanup_hook(env,lease_cleanup,lease.get());check(status);}lease.release();return object;
});}
napi_value create(napi_env env,napi_callback_info info){return guarded(env,[&]{
  size_t count=3;napi_value args[3];check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));if(count!=3)throw ProtocolError("connected fd, ATTACH Buffer and callback required");
  napi_valuetype type;check(napi_typeof(env,args[0],&type));Descriptor socket;
  if(type==napi_string){
    size_t size;check(napi_get_value_string_utf8(env,args[0],nullptr,0,&size));sockaddr_un address{};address.sun_family=AF_UNIX;
  if(!size || size>=sizeof(address.sun_path))throw ProtocolError("local socket path representation invalid");
    size_t copied;check(napi_get_value_string_utf8(env,args[0],address.sun_path,sizeof(address.sun_path),&copied));
    if(std::strlen(address.sun_path)!=size)throw ProtocolError("socket path contains NUL");
    socket=Descriptor(::socket(AF_UNIX,SOCK_SEQPACKET|SOCK_NONBLOCK|SOCK_CLOEXEC,0));
    if(socket.get()<0 || ::connect(socket.get(),reinterpret_cast<sockaddr*>(&address),sizeof(address))<0)throw std::system_error(errno,std::generic_category(),"connect local media");
  }else{
    if(type!=napi_number)throw ProtocolError("trusted local path or descriptor required");
    double numeric;check(napi_get_value_double(env,args[0],&numeric));if(!std::isfinite(numeric) || numeric<0 || numeric>INT32_MAX || std::floor(numeric)!=numeric)throw ProtocolError("descriptor integer required");
    socket=Descriptor(fcntl(int(numeric),F_DUPFD_CLOEXEC,0));if(socket.get()<0)throw std::system_error(errno,std::generic_category(),"duplicate connection");
  }
  napi_value global,constructor,predicate;check(napi_get_global(env,&global));check(napi_get_named_property(env,global,"Buffer",&constructor));check(napi_get_named_property(env,constructor,"isBuffer",&predicate));
  auto attach=decode_buffer(env,args[1],predicate);if(!std::holds_alternative<Attach>(attach.payload))throw ProtocolError("ATTACH required");
  check(napi_typeof(env,args[2],&type));if(type!=napi_function)throw ProtocolError("callback required");
  auto self=std::make_shared<NodeConnection>(env,std::move(attach.target));napi_value object;check(napi_create_object(env,&object));
  auto holder=std::make_unique<Holder>(self);check(napi_wrap(env,object,holder.get(),finalizer,nullptr,nullptr));holder.release();
  napi_property_descriptor methods[]={{"retainAllocation",nullptr,retain_allocation,nullptr,nullptr,nullptr,napi_default,nullptr},{"acceptLayout",nullptr,accept,nullptr,nullptr,nullptr,napi_default,nullptr},{"sendControl",nullptr,send,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,close,nullptr,nullptr,nullptr,napi_default,nullptr}};
  check(napi_define_properties(env,object,4,methods));
  try{
    check(napi_create_reference(env,args[2],1,&self->callback));check(napi_create_reference(env,predicate,1,&self->predicate));
    napi_value resource;check(napi_create_object(env,&resource));check(napi_create_reference(env,resource,1,&self->resource));check(napi_async_init(env,resource,text(env,"mtai.avatar.connection"),&self->context));
    check(napi_add_async_cleanup_hook(env,NodeConnection::cleaning,self.get(),&self->hook));self->keepalive=self;
    uv_loop_t* loop;check(napi_get_uv_event_loop(env,&loop));self->socket=std::move(socket);
    int status=uv_async_init(loop,&self->activation,NodeConnection::activated);if(status<0)throw std::runtime_error(uv_strerror(status));
    self->activation.data=self.get();uv_async_send(&self->activation);
  }catch(...){if(self->hook){napi_remove_async_cleanup_hook(self->hook);self->hook=nullptr;}self->dispose_refs();self->keepalive.reset();throw;}
  return object;
});}
napi_value clock(napi_env env,napi_callback_info){return guarded(env,[&]{timespec value{};if(clock_gettime(CLOCK_MONOTONIC,&value))throw std::system_error(errno,std::generic_category(),"monotonic clock");napi_value result;check(napi_create_bigint_uint64(env,uint64_t(value.tv_sec)*1000000000+uint64_t(value.tv_nsec),&result));return result;});}
}
void install_node_connection(napi_env env,napi_value exports){napi_value function;check(napi_create_function(env,"createConnection",NAPI_AUTO_LENGTH,create,nullptr,&function));prop(env,exports,"createConnection",function);check(napi_create_function(env,"monotonicNs",NAPI_AUTO_LENGTH,clock,nullptr,&function));prop(env,exports,"monotonicNs",function);}
}  // namespace mtai::avatar

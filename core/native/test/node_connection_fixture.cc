#include <node_api.h>
#include <uv.h>
#include "../local_media_transport.h"
#include <sys/socket.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <memory>
#include <cstdlib>
using namespace mtai::avatar;
namespace {
struct Peer {Seqpacket transport;Descriptor memory;explicit Peer(Descriptor fd):transport(std::move(fd)),memory(memfd_create("node-connection",MFD_CLOEXEC)){if(memory.get()<0 || ftruncate(memory.get(),64))throw std::runtime_error("fixture allocation");if(pwrite(memory.get(),"rgba",4,0)!=4)throw std::runtime_error("fixture write");}};
void check(napi_status status){if(status!=napi_ok)throw std::runtime_error("fixture NAPI");}
void prop(napi_env env,napi_value object,const char* key,napi_value value){check(napi_set_named_property(env,object,key,value));}
Peer* peer(napi_env env,napi_callback_info info,size_t& count,napi_value* args){napi_value self;check(napi_get_cb_info(env,info,&count,args,&self,nullptr));void* raw;check(napi_unwrap(env,self,&raw));return static_cast<Peer*>(raw);}
napi_value undef(napi_env env){napi_value v;check(napi_get_undefined(env,&v));return v;}
Record wire(napi_env env,napi_value value){void* data;size_t size;check(napi_get_buffer_info(env,value,&data,&size));std::vector<uint8_t> bytes(size);if(size)std::memcpy(bytes.data(),data,size);return decode(bytes);}
template<class F> napi_value guard(napi_env env,F f){try{return f();}catch(const std::exception& e){napi_throw_error(env,nullptr,e.what());return nullptr;}}
napi_value send(napi_env env,napi_callback_info info){return guard(env,[&]{size_t count=1;napi_value args[1];auto* self=peer(env,info,count,args);auto record=wire(env,args[0]);if(!self->transport.send(record,std::holds_alternative<Layout>(record.payload)?self->memory.get():-1))throw std::runtime_error("fixture would block");return undef(env);});}
napi_value receive(napi_env env,napi_callback_info info){return guard(env,[&]{size_t count=0;auto* self=peer(env,info,count,nullptr);auto incoming=self->transport.receive();if(!incoming.value)return undef(env);auto bytes=encode(incoming.value->record);napi_value value;check(napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&value));return value;});}
napi_value close(napi_env env,napi_callback_info info){return guard(env,[&]{size_t count=0;auto* self=peer(env,info,count,nullptr);self->transport.close();return undef(env);});}
napi_value fd_content(napi_env env,napi_callback_info info){return guard(env,[&]{size_t count=1;napi_value args[1];check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));int32_t fd;check(napi_get_value_int32(env,args[0],&fd));char bytes[4];napi_value result;
  if(fcntl(fd,F_GETFD)<0){check(napi_get_undefined(env,&result));return result;}
  if(!(fcntl(fd,F_GETFD)&FD_CLOEXEC)||pread(fd,bytes,4,0)!=4)throw std::runtime_error("descriptor not accessible/CLOEXEC");
  check(napi_create_string_utf8(env,bytes,4,&result));return result;});}
struct WaitAttach {uv_poll_t poll{};napi_env env;napi_ref callback=nullptr;napi_async_context context=nullptr;napi_ref resource=nullptr;std::string error;};
napi_value wait_attach(napi_env env,napi_callback_info info){return guard(env,[&]{size_t count=1;napi_value args[1];auto* self=peer(env,info,count,args);auto wait=std::make_unique<WaitAttach>();wait->env=env;check(napi_create_reference(env,args[0],1,&wait->callback));napi_value resource,name;check(napi_create_object(env,&resource));check(napi_create_reference(env,resource,1,&wait->resource));check(napi_create_string_utf8(env,"fixture.attach",NAPI_AUTO_LENGTH,&name));check(napi_async_init(env,resource,name,&wait->context));uv_loop_t* loop;check(napi_get_uv_event_loop(env,&loop));if(uv_poll_init(loop,&wait->poll,self->transport.descriptor())<0)throw std::runtime_error("fixture poll init");wait->poll.data=wait.get();uv_poll_start(&wait->poll,UV_READABLE,[](uv_poll_t* handle,int status,int){auto* wait=static_cast<WaitAttach*>(handle->data);if(status<0)wait->error=uv_strerror(status);uv_poll_stop(handle);uv_close(reinterpret_cast<uv_handle_t*>(handle),[](uv_handle_t* handle){std::unique_ptr<WaitAttach> wait(static_cast<WaitAttach*>(handle->data));napi_handle_scope scope;napi_open_handle_scope(wait->env,&scope);napi_value function,global,result;napi_get_reference_value(wait->env,wait->callback,&function);napi_get_global(wait->env,&global);napi_make_callback(wait->env,wait->context,global,function,0,nullptr,&result);napi_delete_reference(wait->env,wait->callback);napi_async_destroy(wait->env,wait->context);napi_delete_reference(wait->env,wait->resource);napi_close_handle_scope(wait->env,scope);});});wait.release();return undef(env);});}
napi_value create(napi_env env,napi_callback_info){return guard(env,[&]{int sockets[2];if(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,sockets))throw std::runtime_error("fixture socketpair");Descriptor client(sockets[1]);auto self=std::make_unique<Peer>(Descriptor(sockets[0]));napi_value object;check(napi_create_object(env,&object));
  check(napi_wrap(env,object,self.get(),[](napi_env,void* data,void*){delete static_cast<Peer*>(data);},nullptr,nullptr));self.release();
  napi_property_descriptor methods[]={{"waitAttach",nullptr,wait_attach,nullptr,nullptr,nullptr,napi_default,nullptr},{"send",nullptr,send,nullptr,nullptr,nullptr,napi_default,nullptr},{"receive",nullptr,receive,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,close,nullptr,nullptr,nullptr,napi_default,nullptr}};check(napi_define_properties(env,object,4,methods));
  napi_value fd;check(napi_create_int32(env,client.get(),&fd));prop(env,object,"fd",fd);client.release();return object;});}
}
extern "C" void mtai_test_connection_start(unsigned stage){const char* mode=std::getenv("MTAI_TEST_CONNECTION_FAILURE");if(mode && unsigned(std::strtoul(mode,nullptr,10))==stage)throw std::runtime_error("fixture connection startup failed");}
extern "C" void mtai_install_connection_fixture(napi_env env,napi_value exports){napi_value function;check(napi_create_function(env,"testPeer",NAPI_AUTO_LENGTH,create,nullptr,&function));prop(env,exports,"testPeer",function);check(napi_create_function(env,"testFdContent",NAPI_AUTO_LENGTH,fd_content,nullptr,&function));prop(env,exports,"testFdContent",function);}

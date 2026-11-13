#include "../local_media_connection.h"
#include <cassert>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
#include <time.h>
#include <iostream>
using namespace mtai::avatar;
bool controlled_clock=false;uint64_t controlled_ns=1000000000;
extern "C" int __real_clock_gettime(clockid_t,timespec*);
extern "C" int __wrap_clock_gettime(clockid_t clock,timespec* value) {
  if(controlled_clock && clock==CLOCK_MONOTONIC){value->tv_sec=controlled_ns/1000000000;value->tv_nsec=controlled_ns%1000000000;return 0;}
  return __real_clock_gettime(clock,value);
}
uint64_t monotonic(){timespec t{};assert(clock_gettime(CLOCK_MONOTONIC,&t)==0);return uint64_t(t.tv_sec)*1000000000+uint64_t(t.tv_nsec);}
Target target{"session","generation","attachment"};
Layout layout(){Layout p;p.allocation=7;p.width=4;p.height=4;p.fourcc=0x34324241;p.stride=16;p.extent=64;p.row_origin=1;p.color_space=1;p.sample_rate=16000;p.channels=1;p.sample_format=1;return p;}
void cycle(bool reentrant,bool callback_failure,bool early_eof) {
  uv_loop_t loop;assert(uv_loop_init(&loop)==0);int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  Seqpacket producer{Descriptor(pair[0])};Descriptor allocation(memfd_create("uv-owner",MFD_CLOEXEC));assert(ftruncate(allocation.get(),64)==0);
  Descriptor imported;std::shared_ptr<LocalConnection> connection;
  int accepted=0,attached=0,eligible=0,eos=0,failed=0,closed=0;uint64_t first_due=0;
  ConnectionEvents events;
  events.layout=[&](Layout value,Descriptor fd){assert(value.allocation==7);imported=std::move(fd);++accepted;};
  events.attached=[&]{++attached;};
  events.eligible=[&](ResolvedFrame frame){
    ++eligible;assert(monotonic()>=frame.phase.deadline_ns);assert(frame.state.turn=="A1");
    assert(frame.frame.pcm==std::vector<uint8_t>({1,2}));
    if(eligible==1)first_due=frame.phase.deadline_ns;
    else {
      assert(frame.phase.old_deadline_ns==first_due+40000000);
      if(frame.phase.reanchored) {
        assert(frame.phase.deadline_ns>frame.phase.old_deadline_ns);
        assert(frame.phase.origin_ns==frame.phase.deadline_ns-40000000);
      } else assert(frame.phase.deadline_ns==frame.phase.old_deadline_ns);
    }
    if(callback_failure)throw std::runtime_error("consumer failed");
    if(reentrant)connection->close();
  };
  events.eos=[&]{++eos;assert(eligible==2);connection->close();};
  events.failure=[&](std::string){++failed;connection->close();};
  events.closed=[&]{++closed;imported=Descriptor();connection->close();};
  connection=LocalConnection::open(&loop,Descriptor(pair[1]),target,std::move(events));
  auto attach=producer.receive();assert(attach.value && std::holds_alternative<Attach>(attach.value->record.payload));
  assert(producer.send({target,layout()},allocation.get()));
  uv_run(&loop,UV_RUN_NOWAIT);assert(accepted==1 && attached==0 && eligible==0);
  assert(producer.receive().status==ReceiveResult::Status::would_block); // no speculative READY
  connection->accept_layout(7);
  auto ready=producer.receive();assert(ready.value && std::holds_alternative<Ready>(ready.value->record.payload));
  assert(producer.send({target,Attached{7}}));
  assert(producer.send({target,OutputState{1,true,std::string("A1"),true}}));
  if(early_eof){producer.close();uv_run(&loop,UV_RUN_DEFAULT);assert(failed==1 && closed==1);}
  else {
    assert(producer.send({target,Frame{1,7,9,0,0,1,{1,2}}}));
    // Stop source reuse implicitly: first eligibility still emits no ACK.
    uv_run(&loop,UV_RUN_NOWAIT);assert(eligible==1);
    if(!reentrant && !callback_failure) {
      assert(producer.receive().status==ReceiveResult::Status::would_block);
      assert(producer.send({target,Frame{2,7,10,0,1,1,{1,2}}}));
      assert(producer.send({target,Eos{2,2}}));
      producer.close();uv_run(&loop,UV_RUN_DEFAULT);
      assert(eligible==2 && eos==1 && failed==0 && closed==1);
    } else {uv_run(&loop,UV_RUN_DEFAULT);assert(closed==1 && eos==0 && eligible==1);assert(failed==(callback_failure?1:0));}
  }
  connection->close();connection.reset();assert(uv_loop_close(&loop)==0);
}
void write_readiness() {
  uv_loop_t loop;assert(uv_loop_init(&loop)==0);int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  int small=4096;assert(setsockopt(pair[1],SOL_SOCKET,SO_SNDBUF,&small,sizeof(small))==0);
  Seqpacket producer{Descriptor(pair[0])};int closed=0;
  ConnectionEvents events;events.closed=[&]{++closed;};events.failure=[](std::string){assert(false);};
  auto connection=LocalConnection::open(&loop,Descriptor(pair[1]),target,std::move(events));
  assert(producer.receive().value);
  // The socket fills; remaining control ownership must persist across readiness
  // callbacks rather than borrowing stack records or silently dropping writes.
  for(unsigned i=0;i<64;i++)connection->send_control({target,Failure{i,std::string(1024,char('a'+i%26))}});
  unsigned observed=0;
  while(observed<64) {
    while(true) {
      auto incoming=producer.receive();if(incoming.status==ReceiveResult::Status::would_block)break;
      assert(incoming.value);auto value=std::get<Failure>(incoming.value->record.payload);
      assert(value.code==observed && value.message==std::string(1024,char('a'+observed%26)));++observed;
    }
    uv_run(&loop,UV_RUN_NOWAIT);
  }
  connection->close();connection.reset();uv_run(&loop,UV_RUN_DEFAULT);assert(closed==1);assert(uv_loop_close(&loop)==0);
}
void failure_while_waiting() {
  controlled_clock=true;controlled_ns=1000000000;
  uv_loop_t loop;assert(uv_loop_init(&loop)==0);int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  Seqpacket producer{Descriptor(pair[0])};Descriptor fd(memfd_create("control-wait",MFD_CLOEXEC));assert(ftruncate(fd.get(),64)==0);
  std::shared_ptr<LocalConnection> connection;int eligible=0,failed=0,closed=0;
  ConnectionEvents events;events.layout=[&](Layout p,Descriptor){connection->accept_layout(p.allocation);};
  events.eligible=[&](ResolvedFrame){++eligible;};events.failure=[&](std::string){++failed;};events.closed=[&]{++closed;};
  connection=LocalConnection::open(&loop,Descriptor(pair[1]),target,std::move(events));assert(producer.receive().value);
  assert(producer.send({target,layout()},fd.get()));uv_run(&loop,UV_RUN_NOWAIT);assert(producer.receive().value);
  assert(producer.send({target,Attached{7}}));assert(producer.send({target,OutputState{1,true,{},true}}));
  assert(producer.send({target,Frame{1,7,1,0,0,0,{}}}));uv_run(&loop,UV_RUN_NOWAIT);assert(eligible==1);
  assert(producer.send({target,Frame{2,7,2,0,0,0,{}}}));assert(producer.send({target,Failure{9,"terminal while gated"}}));
  uv_run(&loop,UV_RUN_DEFAULT);assert(eligible==1 && failed==1 && closed==1);connection.reset();assert(uv_loop_close(&loop)==0);
  controlled_clock=false;
}
void eos_with_backpressured_controls() {
  controlled_clock=true;controlled_ns=1000000000;
  uv_loop_t loop;assert(uv_loop_init(&loop)==0);int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  int small=4096;assert(setsockopt(pair[1],SOL_SOCKET,SO_SNDBUF,&small,sizeof(small))==0);
  Seqpacket producer{Descriptor(pair[0])};Descriptor fd(memfd_create("eos-write",MFD_CLOEXEC));assert(ftruncate(fd.get(),64)==0);
  std::shared_ptr<LocalConnection> connection;int eligible=0,eos=0,failed=0,closed=0;
  ConnectionEvents events;events.layout=[&](Layout p,Descriptor){connection->accept_layout(p.allocation);};
  events.eligible=[&](ResolvedFrame frame){++eligible;assert(monotonic()>=frame.phase.deadline_ns);};
  events.eos=[&]{++eos;assert(eligible==2);connection->close();};
  events.failure=[&](std::string){++failed;};events.closed=[&]{++closed;};
  connection=LocalConnection::open(&loop,Descriptor(pair[1]),target,std::move(events));assert(producer.receive().value);
  assert(producer.send({target,layout()},fd.get()));uv_run(&loop,UV_RUN_NOWAIT);assert(producer.receive().value);
  assert(producer.send({target,Attached{7}}));assert(producer.send({target,OutputState{1,true,{},true}}));
  assert(producer.send({target,Frame{1,7,1,0,0,0,{}}}));uv_run(&loop,UV_RUN_NOWAIT);assert(eligible==1);
  assert(producer.send({target,Frame{2,7,2,0,0,0,{}}}));assert(producer.send({target,Eos{2,0}}));
  uv_run(&loop,UV_RUN_NOWAIT);assert(eligible==1 && eos==0);
  for(unsigned i=0;i<64;i++)connection->send_control({target,Failure{i,std::string(1024,'q')}});
  unsigned received=0;
  while(producer.receive().status==ReceiveResult::Status::record)++received;
  assert(received>0 && received<64);producer.close();
  connection->send_control({target,Failure{65,"write discovers orderly EOF"}});
  assert(eligible==1 && eos==0 && failed==0);controlled_ns+=40000000;
  uv_run(&loop,UV_RUN_DEFAULT);assert(eligible==2 && eos==1 && failed==0 && closed==1);
  connection.reset();assert(uv_loop_close(&loop)==0);controlled_clock=false;
}
int main(){cycle(false,false,false);cycle(true,false,false);cycle(false,true,false);cycle(false,false,true);write_readiness();failure_while_waiting();eos_with_backpressured_controls();std::cout<<"libuv ownership/eligibility/acceptance/EOF/reentrant close/write readiness/terminal controls passed\n";}

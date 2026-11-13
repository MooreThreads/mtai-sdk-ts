#include "../pcm_custody.h"
#include <atomic>
#include <cassert>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <new>
#include <thread>

thread_local bool realtime=false;
thread_local long fail_allocation=-1;
void allocation_fault(){if(fail_allocation==0)throw std::bad_alloc();if(fail_allocation>0)--fail_allocation;}
std::atomic<unsigned> rt_allocations{0},rt_frees{0};
void* operator new(std::size_t size){allocation_fault();if(realtime)++rt_allocations;if(auto* p=std::malloc(size?size:1))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{if(realtime && p)++rt_frees;std::free(p);}
void operator delete(void* p,std::size_t) noexcept{::operator delete(p);}
void* operator new[](std::size_t size){return ::operator new(size);}
void operator delete[](void* p) noexcept{::operator delete(p);}
void operator delete[](void* p,std::size_t) noexcept{::operator delete(p);}
using namespace mtai::avatar;
// Only harness threading/locks: production PCM process does not own these.
class ProcessingLoop {
 public:
  ProcessingLoop():thread_([this]{run();}){}
  ~ProcessingLoop(){{std::lock_guard<std::mutex> lock(mutex_);quit_=true;}ready_.notify_one();thread_.join();}
  void invoke(PcmCustody::Command command,void* data) {
    std::unique_lock<std::mutex> lock(mutex_);done_.wait(lock,[&]{return !command_;});command_=command;data_=data;ready_.notify_one();
    done_.wait(lock,[&]{return !command_;});
  }
 private:
  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    while(true){ready_.wait(lock,[&]{return quit_||command_;});if(quit_)return;
      auto command=command_;auto data=data_;lock.unlock();command(data);lock.lock();command_=nullptr;done_.notify_all();}
  }
  std::mutex mutex_;std::condition_variable ready_,done_;bool quit_=false;
  PcmCustody::Command command_=nullptr;void* data_=nullptr;std::thread thread_;
};
Target target{"session","generation","attachment"};
ResolvedFrame frame(uint64_t sequence,std::optional<std::string> turn,std::vector<uint8_t> bytes) {
  auto count=bytes.size()/2;
  return {target,Frame{sequence,7,sequence,0,0,count,std::move(bytes)},EffectiveState{turn,true},PhaseDecision{}};
}
void notified(void* data) noexcept {static_cast<std::atomic<unsigned>*>(data)->fetch_add(1,std::memory_order_relaxed);}
struct Copy {
  PcmCustody* owner;uint8_t* destination;size_t capacity;uint64_t requested;size_t copied=0;
  static void run(void* value) noexcept{auto& self=*static_cast<Copy*>(value);realtime=true;self.copied=self.owner->process(self.destination,self.capacity,self.requested);realtime=false;}
};
size_t process(ProcessingLoop& loop,PcmCustody& owner,uint8_t* data,size_t capacity,uint64_t requested=0) {
  Copy copy{&owner,data,capacity,requested};loop.invoke(Copy::run,&copy);return copy.copied;
}
template<class F> void rejects(F function){bool failed=false;try{function();}catch(const ProtocolError&){failed=true;}assert(failed);}
void custody() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};
  PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
  uint8_t output[16];std::memset(output,0xee,sizeof(output));
  owner.submit(frame(1,"A1",{1,2,3,4,5,6}));owner.submit(frame(2,"B2",{7,8,9,10}));
  assert(process(loop,owner,output,9,2)==4);assert(std::memcmp(output,"\1\2\3\4",4)==0 && output[4]==0xee);
  assert(owner.collect().empty());owner.begin_stop(target,"A1");assert(owner.whole_stream_flush_permitted());
  owner.submit(frame(3,"B2",{11,12}));owner.submit(frame(4,"A1",{99,100}));
  assert(process(loop,owner,output,16)==0);owner.stream_reset_completed();owner.resume();
  assert(process(loop,owner,output,16)==6);assert(std::memcmp(output,"\7\10\11\12\13\14",6)==0);
  auto completed=owner.collect();assert(completed.size()==4);
  assert(completed[0].identity.sequence==1 && completed[0].disposition==PcmDisposition::cancelled);
  assert(completed[1].identity.sequence==4 && completed[1].disposition==PcmDisposition::cancelled);
  assert(completed[2].identity.sequence==2 && completed[2].identity.turn=="B2" && completed[2].disposition==PcmDisposition::copied);
  assert(completed[3].identity.sequence==3 && completed[3].disposition==PcmDisposition::copied);
  assert(owner.collect().empty());assert(notifications.load()==3);
  owner.begin_stop(target,"A1");assert(!owner.whole_stream_flush_permitted());
  rejects([&]{owner.stream_reset_completed();});owner.resume();
  owner.submit(frame(5,{},{}));assert(owner.collect().front().identity.sample_count==0);
  owner.submit(frame(6,"B2",{13,14}));owner.end();assert(!owner.handoff_complete());
  rejects([&]{owner.submit(frame(7,"B2",{15,16}));});
  assert(process(loop,owner,output,16)==2);assert(owner.handoff_complete());owner.close();owner.close();
}
void protected_partial() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};
  PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
  uint8_t output[8]{};
  owner.submit(frame(1,"B2",{1,2,3,4,5,6}));assert(process(loop,owner,output,2)==2);
  owner.submit(frame(2,"A1",{77,78}));owner.begin_stop(target,"A1");assert(!owner.whole_stream_flush_permitted());
  owner.submit(frame(3,"B2",{7,8}));owner.resume();assert(process(loop,owner,output,8)==6);
  assert(std::memcmp(output,"\3\4\5\6\7\10",6)==0);
  auto complete=owner.collect();assert(complete.size()==3 && complete[1].identity.sequence==1 && complete[1].identity.turn=="B2");
  auto wrong=target;wrong.generation="other";rejects([&]{owner.begin_stop(wrong,"B2");});
  owner.close();
}
void mixed_handed_scopes() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};
  PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
  uint8_t output[8]{};
  owner.submit(frame(1,"A1",{1,2}));owner.submit(frame(2,"B2",{3,4,5,6,7,8}));
  assert(process(loop,owner,output,4)==4);assert(std::memcmp(output,"\1\2\3\4",4)==0);
  owner.begin_stop(target,"A1");assert(!owner.whole_stream_flush_permitted());
  rejects([&]{owner.stream_reset_completed();});owner.resume();
  assert(process(loop,owner,output,8)==4);assert(std::memcmp(output,"\5\6\7\10",4)==0);
  auto completed=owner.collect();assert(completed.size()==2);
  assert(completed[0].identity.sequence==1 && completed[0].disposition==PcmDisposition::copied);
  assert(completed[1].identity.target==target && completed[1].identity.turn=="B2"
    && completed[1].identity.sequence==2 && completed[1].identity.sample_count==3
    && completed[1].disposition==PcmDisposition::copied);
  assert(owner.collect().empty());owner.close();
}
void unknown_scope() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};
  PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
  uint8_t output[2];owner.submit(frame(1,{}, {1,2}));assert(process(loop,owner,output,2)==2);
  owner.begin_stop(target,"A1");assert(!owner.whole_stream_flush_permitted());owner.close();
}
void close_joins_inflight() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};std::atomic<bool> closing{false},barrier_entered{false},joined{false};
  PcmCustody owner(target,1,[&](auto command,void* data){if(closing)barrier_entered=true;loop.invoke(command,data);},notified,&notifications);
  owner.submit(frame(1,"B2",{1,2,3,4}));
  struct Flight {
    PcmCustody* owner;std::atomic<bool> entered{false},release{false};uint8_t bytes[2]{};
    static void run(void* data) noexcept {
      auto& self=*static_cast<Flight*>(data);self.entered=true;
      while(!self.release.load())std::this_thread::yield(); // harness interleaving, not production RT code
      realtime=true;assert(self.owner->process(self.bytes,2,1)==2);realtime=false;
    }
  } flight{&owner};
  std::thread processing([&]{loop.invoke(Flight::run,&flight);});
  while(!flight.entered.load())std::this_thread::yield();
  std::thread control([&]{closing=true;owner.close();joined=true;});
  while(!barrier_entered.load())std::this_thread::yield();
  assert(!joined);flight.release=true;processing.join();control.join();
  assert(joined && flight.bytes[0]==1 && flight.bytes[1]==2);owner.close();
}
void notification_only_completions() {
  ProcessingLoop loop;std::atomic<unsigned> notifications{0};
  PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
  owner.submit(frame(1,"B2",{}));assert(notifications.exchange(0)==1);
  auto empty=owner.collect();assert(empty.size()==1 && empty[0].identity.sequence==1);
  owner.submit(frame(2,"A1",{1,2}));owner.submit(frame(3,"A1",{3,4}));
  owner.begin_stop(target,"A1");assert(notifications.exchange(0)==1);
  auto pruned=owner.collect();assert(pruned.size()==2);
  for(const auto& completion:pruned)assert(completion.disposition==PcmDisposition::cancelled);
  owner.submit(frame(4,"A1",{5,6}));assert(notifications.exchange(0)==1);
  auto late=owner.collect();assert(late.size()==1 && late[0].identity.sequence==4 && late[0].disposition==PcmDisposition::cancelled);
  owner.close();
}
void collect_allocation_failures() {
  bool succeeded=false;unsigned failures=0;
  // Exhaust actual allocation sites until a successful collect; this is test
  // fault enumeration, not a runtime retry/limit or private container assertion.
  for(long allocation=0;!succeeded;++allocation) {
    ProcessingLoop loop;std::atomic<unsigned> notifications{0};
    PcmCustody owner(target,1,[&](auto command,void* data){loop.invoke(command,data);},notified,&notifications);
    owner.submit(frame(1,std::string(128,'A'),{}));owner.submit(frame(2,std::string(128,'B'),{}));
    fail_allocation=allocation;std::vector<PcmCompletion> completions;
    try {completions=owner.collect();succeeded=true;}catch(const std::bad_alloc&){++failures;}
    fail_allocation=-1;
    if(!succeeded)completions=owner.collect();
    assert(completions.size()==2 && completions[0].identity.sequence==1 && completions[1].identity.sequence==2);
    assert(completions[0].identity.turn==std::string(128,'A') && completions[1].identity.turn==std::string(128,'B'));
    assert(owner.collect().empty());owner.close();
  }
  assert(failures>1);
}
int main(){custody();protected_partial();mixed_handed_scopes();unknown_scope();close_joins_inflight();notification_only_completions();collect_allocation_failures();assert(rt_allocations==0 && rt_frees==0);std::cout<<"PCM exact bytes/scoped stop/partial B/EOS/barrier ownership/no RT allocation passed\n";}

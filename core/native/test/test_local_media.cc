#include "../local_media_transport.h"
#include "../local_media_state.h"
#include <cassert>
#include <array>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <iostream>
#include <sstream>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

using namespace mtai::avatar;
template<class Operation> void rejects(Operation operation) {
  bool rejected=false;try{operation();}catch(const std::exception&){rejected=true;}assert(rejected);
}
Target target{"session","generation","attachment"};
Layout layout() {
  Layout p;p.allocation=7;p.width=4;p.height=4;p.fourcc=0x34324241;p.stride=16;
  p.extent=64;p.row_origin=1;p.color_space=1;p.sample_rate=16000;p.channels=1;p.sample_format=1;return p;
}
void ordered() {
  OutputResolver state(target);auto p=layout();
  state.accept({target,p},0);state.accept({target,Attached{7}},0);
  state.accept({target,OutputState{1,true,std::string("A1"),true}},0);
  state.accept({target,OutputState{3,false,std::string("B2"),false}},0);
  auto first=state.accept({target,Frame{1,7,17,99999,0,2,{1,0,255,127}}},100);
  assert(first && first->state.turn=="A1" && first->phase.deadline_ns==100);
  auto second=state.accept({target,Frame{2,7,18,99999,2,0,{}}},200);
  assert(second && second->state.turn=="A1" && second->phase.deadline_ns==40000100);
  rejects([&]{state.accept({target,Frame{3,7,19,99999,2,1,{}}},300);});
  auto third=state.accept({target,Frame{3,7,19,99999,2,1,{2,0}}},90000100);
  assert(third && third->state.turn=="B2" && !third->state.audio_active);
  assert(third->phase.reanchored && third->phase.origin_ns==10000100);
  state.accept({target,Eos{3,3}},0);assert(!state.attached());
  rejects([&]{state.accept({target,Eos{3,3}},0);});
  OutputResolver empty(target);empty.accept({target,p},0);empty.accept({target,Attached{7}},0);empty.accept({target,Eos{0,0}},0);
  OutputResolver fence(target);auto wrong=target;wrong.generation="other";
  assert(!fence.accept({wrong,p},0));rejects([&]{fence.accept({target,Attached{7}},0);});
}
size_t descriptors_open() {
  DIR* directory=opendir("/proc/self/fd");assert(directory);size_t count=0;
  while(auto* entry=readdir(directory))if(entry->d_name[0]!='.')++count;
  closedir(directory);return count;
}
void raw_send(int socket,const std::vector<uint8_t>& bytes,const std::vector<int>& fds) {
  std::vector<unsigned char> control(CMSG_SPACE(fds.size()*sizeof(int)));
  iovec vector{const_cast<uint8_t*>(bytes.data()),bytes.size()};msghdr message{};
  message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control.data();message.msg_controllen=control.size();
  auto* item=CMSG_FIRSTHDR(&message);item->cmsg_level=SOL_SOCKET;item->cmsg_type=SCM_RIGHTS;
  item->cmsg_len=CMSG_LEN(fds.size()*sizeof(int));std::memcpy(CMSG_DATA(item),fds.data(),fds.size()*sizeof(int));
  assert(sendmsg(socket,&message,0)==ssize_t(bytes.size()));
}
void ancillary_rejection() {
  int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  Seqpacket sender{Descriptor(pair[0])},receiver{Descriptor(pair[1])};
  Descriptor fd(memfd_create("ancillary",MFD_CLOEXEC));assert(fd.get()>=0);
  size_t baseline=descriptors_open();
  for(int count:{1,2,3,9}) {
    raw_send(sender.descriptor(),encode({target,Attach{}}),std::vector<int>(size_t(count),fd.get()));
    rejects([&]{receiver.receive();});assert(descriptors_open()==baseline);
  }
  raw_send(sender.descriptor(),{'x'}, {fd.get()});
  rejects([&]{receiver.receive();});assert(descriptors_open()==baseline);
  raw_send(sender.descriptor(),{}, {fd.get()});
  rejects([&]{receiver.receive();});assert(descriptors_open()==baseline);
  raw_send(sender.descriptor(),encode({target,layout()}),{fd.get(),fd.get()});
  rejects([&]{receiver.receive();});assert(descriptors_open()==baseline);
  auto p_overflow=layout();p_overflow.offset=std::numeric_limits<uint64_t>::max();
  rejects([&]{validate_layout(p_overflow);});
  p_overflow=layout();p_overflow.height=std::numeric_limits<uint32_t>::max();
  p_overflow.stride=std::numeric_limits<uint64_t>::max();
  rejects([&]{validate_layout(p_overflow);});
  Descriptor small(memfd_create("small",MFD_CLOEXEC));assert(ftruncate(small.get(),16)==0);
  rejects([&]{validate_allocation(layout(),small.get());});
  OutputResolver before(target);
  rejects([&]{before.accept({target,OutputState{1,true,{},false}},0);});
  before.accept({target,layout()},0);before.accept({target,Attached{7}},0);
  rejects([&]{before.accept({target,Frame{1,7,1,0,0,0,{}}},0);});
  before.accept({target,OutputState{1,true,{},false}},0);
  rejects([&]{before.accept({target,OutputState{1,false,{},true}},0);});
  auto recovered=before.accept({target,Frame{1,7,1,0,0,0,{}}},9007199254740993ULL);
  assert(recovered && recovered->phase.initial_origin_ns==9007199254740993ULL);
  rejects([&]{before.accept({target,Eos{1,1}},0);});
  before.accept({target,Eos{1,0}},0);
}
void sockets() {
  int pair[2];assert(socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair)==0);
  Seqpacket sender{Descriptor(pair[0])},receiver{Descriptor(pair[1])};
  assert(receiver.receive().status==ReceiveResult::Status::would_block);
  Descriptor source(memfd_create("native-wire",MFD_CLOEXEC));assert(source.get()>=0);
  assert(ftruncate(source.get(),64)==0);assert(pwrite(source.get(),"rgba",4,0)==4);
  assert(sender.send({target,layout()},source.get()));source=Descriptor();
  auto got=receiver.receive();assert(got.status==ReceiveResult::Status::record && got.value);
  assert(fcntl(got.value->descriptor.get(),F_GETFD)&FD_CLOEXEC);
  validate_allocation(std::get<Layout>(got.value->record.payload),got.value->descriptor.get());
  char text[4];assert(pread(got.value->descriptor.get(),text,4,0)==4);assert(std::string(text,4)=="rgba");
  assert(sender.send({target,Frame{1,7,9,0,0,1,{1,2}}}));
  auto frame=receiver.receive();assert(frame.value && frame.value->received_ns>0);
  assert(std::get<Frame>(frame.value->record.payload).pcm==std::vector<uint8_t>({1,2}));
  // A record declaring LAYOUT without ancillary ownership must be rejected.
  auto bytes=encode({target,layout()});assert(send(sender.descriptor(),bytes.data(),bytes.size(),0)==ssize_t(bytes.size()));
  rejects([&]{receiver.receive();});
  sender.close();assert(receiver.receive().status==ReceiveResult::Status::closed);receiver.close();receiver.close();
}
int main(int argc,char**) {
  if(argc>1) {
    std::string line;
    while(std::getline(std::cin,line)) {
      std::vector<uint8_t> bytes;
      assert(line.size()%2==0);
      for(size_t i=0;i<line.size();i+=2)bytes.push_back(uint8_t(std::stoul(line.substr(i,2),nullptr,16)));
      auto output=encode(decode(bytes));static const char* digits="0123456789abcdef";
      for(auto value:output)std::cout<<digits[value>>4]<<digits[value&15];
      std::cout<<'\n';
    }
    return 0;
  }
  ordered();sockets();ancillary_rejection();
  auto valid=encode({target,OutputState{1,true,std::string("\xef\xbb\xbf\0x",5),false}});
  assert(encode(decode(valid))==valid);
  for(size_t length=0;length<valid.size();length++)rejects([&]{decode({valid.begin(),valid.begin()+length});});
  rejects([&]{encode({Target{std::string("\xc0\x80",2),"g","a"},Attach{}});});
  auto boolean=encode({target,OutputState{1,true,{},false}});
  boolean.back()=2;rejects([&]{decode(boolean);});
  for(const std::string& invalid:{std::string("\xed\xa0\x80",3),std::string("\xf4\x90\x80\x80",4),std::string("\xe2\x82",2)}) {
    rejects([&]{encode({Target{invalid,"g","a"},Attach{}});});
  }
  auto bad=encode({target,Attach{}});bad.push_back(0);rejects([&]{decode(bad);});
  std::cout<<"native codec/state/SEQPACKET tests passed\n";
}

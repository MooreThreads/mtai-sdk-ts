#include "local_media_transport.h"
#include <array>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include <system_error>

namespace mtai::avatar {
namespace {
[[noreturn]] void system_error(const char* operation) { throw std::system_error(errno,std::generic_category(),operation); }
bool pending() { return errno==EAGAIN || errno==EWOULDBLOCK; }
}
Descriptor::~Descriptor() { if(fd_>=0)::close(fd_); }
Descriptor& Descriptor::operator=(Descriptor&& other) noexcept {
  if(this!=&other){if(fd_>=0)::close(fd_);fd_=other.release();}return *this;
}
Seqpacket::Seqpacket(Descriptor socket):socket_(std::move(socket)) {
  int type=0;socklen_t size=sizeof(type);
  if(getsockopt(socket_.get(),SOL_SOCKET,SO_TYPE,&type,&size))system_error("socket type");
  int domain=0;size=sizeof(domain);
  if(getsockopt(socket_.get(),SOL_SOCKET,SO_DOMAIN,&domain,&size))system_error("socket domain");
  if(type!=SOCK_SEQPACKET || domain!=AF_UNIX)throw ProtocolError("local SEQPACKET socket required");
  int flags=fcntl(socket_.get(),F_GETFL);
  if(flags<0 || fcntl(socket_.get(),F_SETFL,flags|O_NONBLOCK))system_error("nonblocking socket");
  int descriptor_flags=fcntl(socket_.get(),F_GETFD);
  if(descriptor_flags<0 || fcntl(socket_.get(),F_SETFD,descriptor_flags|FD_CLOEXEC))system_error("socket CLOEXEC");
}
ReceiveResult Seqpacket::receive() {
  uint8_t probe=0;iovec probe_vector{&probe,1};msghdr peek{};peek.msg_iov=&probe_vector;peek.msg_iovlen=1;
  ssize_t length=recvmsg(socket_.get(),&peek,MSG_PEEK|MSG_TRUNC|MSG_DONTWAIT);
  if(length<0){if(pending()||errno==EINTR)return {ReceiveResult::Status::would_block,{}};system_error("probe record");}
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  // One descriptor is the schema, not a media-size ceiling. On ancillary
  // truncation Linux closes undisclosed SCM_RIGHTS entries; visible ones are
  // captured below before any validation can throw.
  alignas(cmsghdr) std::array<unsigned char,CMSG_SPACE(sizeof(int))> control{};
  iovec vector{bytes.data(),bytes.size()};msghdr message{};
  message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control.data();message.msg_controllen=control.size();
  std::vector<Descriptor> descriptors;
  // Reserve before consuming ancillary FDs: exception unwinding must never
  // strand a just-received raw descriptor while constructing its RAII owner.
  descriptors.reserve((control.size()-CMSG_LEN(0))/sizeof(int));
  ssize_t count=recvmsg(socket_.get(),&message,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
  if(count<0){if(pending()||errno==EINTR)return {ReceiveResult::Status::would_block,{}};system_error("consume record");}
  // Capture immediately after consumption, before decoding or PCM copying.
  timespec receipt{};int clock_status=clock_gettime(CLOCK_MONOTONIC,&receipt);int clock_errno=errno;
  bool bad_ancillary=false;
  for(cmsghdr* item=CMSG_FIRSTHDR(&message);item;item=CMSG_NXTHDR(&message,item)) {
    if(item->cmsg_len<CMSG_LEN(0)) {bad_ancillary=true;continue;}
    size_t payload=item->cmsg_len-CMSG_LEN(0);
    if(item->cmsg_level!=SOL_SOCKET || item->cmsg_type!=SCM_RIGHTS || payload%sizeof(int)) {
      bad_ancillary=true;continue;
    }
    for(size_t offset=0;offset<payload;offset+=sizeof(int)) {
      int fd;std::memcpy(&fd,static_cast<unsigned char*>(CMSG_DATA(item))+offset,sizeof(fd));
      descriptors.emplace_back(fd);
    }
  }
  if(clock_status){errno=clock_errno;system_error("FRAME receipt clock");}
  if(count==0 && descriptors.empty() && !bad_ancillary
      && !(message.msg_flags&(MSG_TRUNC|MSG_CTRUNC)))return {ReceiveResult::Status::closed,{}};
  if(count==0)throw ProtocolError("empty local media record");
  if(count!=length || message.msg_flags&(MSG_TRUNC|MSG_CTRUNC) || bad_ancillary)
    throw ProtocolError("truncated record or malformed ancillary data");
  Record record=decode(bytes);
  bool layout=std::holds_alternative<Layout>(record.payload);
  if(descriptors.size()!=(layout?1u:0u))throw ProtocolError("LAYOUT requires exactly one descriptor");
  Descriptor descriptor;
  if(layout)descriptor=std::move(descriptors.front());
  uint64_t received_ns=uint64_t(receipt.tv_sec)*1000000000+uint64_t(receipt.tv_nsec);
  return {ReceiveResult::Status::record,Received{std::move(record),std::move(descriptor),received_ns}};
}
bool Seqpacket::send(const Record& record,int descriptor) {
  bool layout=std::holds_alternative<Layout>(record.payload);
  if(layout!=(descriptor>=0))throw ProtocolError("LAYOUT descriptor schema mismatch");
  auto bytes=encode(record);iovec vector{bytes.data(),bytes.size()};msghdr message{};
  message.msg_iov=&vector;message.msg_iovlen=1;
  alignas(cmsghdr) std::array<unsigned char,CMSG_SPACE(sizeof(int))> control{};
  if(layout){message.msg_control=control.data();message.msg_controllen=control.size();auto* item=CMSG_FIRSTHDR(&message);
    item->cmsg_level=SOL_SOCKET;item->cmsg_type=SCM_RIGHTS;item->cmsg_len=CMSG_LEN(sizeof(int));std::memcpy(CMSG_DATA(item),&descriptor,sizeof(int));}
  ssize_t count=sendmsg(socket_.get(),&message,MSG_DONTWAIT|MSG_NOSIGNAL);
  if(count<0){if(pending()||errno==EINTR)return false;system_error("send record");}
  if(size_t(count)!=bytes.size())throw ProtocolError("non-atomic seqpacket send");
  return true;
}
void Seqpacket::close(){socket_=Descriptor();}
}  // namespace mtai::avatar

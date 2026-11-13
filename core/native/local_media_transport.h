#ifndef MTAI_LOCAL_MEDIA_TRANSPORT_H
#define MTAI_LOCAL_MEDIA_TRANSPORT_H
#include "local_media_protocol.h"
#include <optional>

namespace mtai::avatar {
class Descriptor {
 public:
  explicit Descriptor(int fd=-1):fd_(fd) {}
  ~Descriptor();
  Descriptor(const Descriptor&)=delete;
  Descriptor& operator=(const Descriptor&)=delete;
  Descriptor(Descriptor&& other) noexcept:fd_(other.release()) {}
  Descriptor& operator=(Descriptor&& other) noexcept;
  int get() const { return fd_; }
  int release() { int value=fd_;fd_=-1;return value; }
 private:int fd_;
};
struct Received { Record record;Descriptor descriptor;uint64_t received_ns; };
struct ReceiveResult {
  enum class Status { would_block, closed, record } status;
  std::optional<Received> value;
};
// One event-loop owner serializes send/receive/close. No blocking I/O, worker,
// media inventory or scheduling policy. descriptor() feeds later uv_poll.
class Seqpacket {
 public:
  explicit Seqpacket(Descriptor socket);
  int descriptor() const { return socket_.get(); }
  ReceiveResult receive();
  bool send(const Record& record,int descriptor=-1); // false -> writable readiness
  void close();
 private:Descriptor socket_;
};
}  // namespace mtai::avatar
#endif

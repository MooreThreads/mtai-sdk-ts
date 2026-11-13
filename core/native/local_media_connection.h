#ifndef MTAI_LOCAL_MEDIA_CONNECTION_H
#define MTAI_LOCAL_MEDIA_CONNECTION_H
#include "local_media_transport.h"
#include "local_media_state.h"
#include <uv.h>
#include <deque>
#include <functional>
#include <memory>

namespace mtai::avatar {
struct ConnectionEvents {
  // Layout transfers its FD to the actual native acceptance owner. Receipt is
  // not acceptance: accept_layout() must be called separately after real work.
  std::function<void(Layout,Descriptor)> layout;
  std::function<void()> attached;
  // Eligibility releases paired owned PCM+state together, NOT frameApplied.
  std::function<void(ResolvedFrame)> eligible;
  std::function<void()> eos;
  std::function<void(std::string)> failure;
  std::function<void()> closed;
};
class LocalConnection : public std::enable_shared_from_this<LocalConnection> {
 public:
  static std::shared_ptr<LocalConnection> open(uv_loop_t* loop,Descriptor socket,
                                               Target target,ConnectionEvents events);
  // All methods run on the owning loop thread. No implicit import/audio ready.
  void accept_layout(uint64_t allocation);
  // Explicit control submission only; future healthy texture owner constructs
  // REUSE_ACK. This transport does not certify submission/references/device use.
  void send_control(Record record);
  void close();
  bool closing() const {return closing_;}
 private:
  LocalConnection(Descriptor socket,Target target,ConnectionEvents events);
  void start(uv_loop_t* loop);
  void poll(int status,int events);
  void consume(Received received);
  void write();
  void orderly_eof();
  void arm();
  void deliver();
  void fail(const std::string& message) noexcept;
  void close_handle();
  static void polled(uv_poll_t*,int,int) noexcept;
  static void timed(uv_timer_t*) noexcept;
  static void retired(uv_handle_t*) noexcept;
  Seqpacket socket_;
  Target target_;
  ConnectionEvents events_;
  OutputResolver resolver_;
  std::optional<Layout> layout_;
  bool accepted_=false,closing_=false,eos_received_=false,eos_emitted_=false,eof_=false;
  bool poll_initialized_=false,timer_initialized_=false;
  unsigned closing_handles_=0;
  uv_poll_t poll_{};
  uv_timer_t timer_{};
  std::deque<Record> writes_;
  std::deque<ResolvedFrame> frames_;
  std::shared_ptr<LocalConnection> keepalive_;
};
}  // namespace mtai::avatar
#endif

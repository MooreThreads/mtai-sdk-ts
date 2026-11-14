#ifndef MTAI_ASYNC_PLAYBACK_H
#define MTAI_ASYNC_PLAYBACK_H
#include "pipewire_output.h"
#include <uv.h>
#include <condition_variable>
#include <deque>
#include <functional>
#include <thread>

namespace mtai::avatar {
struct PlaybackEvents {
  std::function<void()> ready;
  std::function<void(std::vector<PcmCompletion>)> completed;
  std::function<void()> drained;
  std::function<void(std::string)> failed;
  std::function<void()> closed;
};
// libuv-thread public API; one owned worker serializes actual PW operations.
// Events are only delivered on libuv. No native READY/frameApplied/reuse ACK.
class AsyncPlayback : public std::enable_shared_from_this<AsyncPlayback> {
 public:
  static std::shared_ptr<AsyncPlayback> open(uv_loop_t*,Target,Layout,PlaybackEvents);
  void submit(ResolvedFrame);
  void stop(Target,std::string turn);
  void end();
  void close();
 private:
  struct Stop {Target target;std::string turn;};
  struct End {};
  using Command=std::variant<ResolvedFrame,Stop,End>;
  struct Ready {};
  struct Drained {};
  using Event=std::variant<Ready,std::vector<PcmCompletion>,Drained>;
  AsyncPlayback(Target,Layout,PlaybackEvents);
  void enqueue(Command);
  void request_close(bool retry);
  void run() noexcept;
  void post(Event);
  void report(std::exception_ptr) noexcept;
  void deliver() noexcept;
  static void notify(void*) noexcept;
  static void awakened(uv_async_t*) noexcept;
  static void retired(uv_handle_t*) noexcept;
  PipewireOutput output_;
  PlaybackEvents events_;
  uv_async_t async_{};
  std::thread worker_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Command> commands_;
  std::deque<Event> results_;
  bool collect_=false,close_requested_=false,retry_requested_=false,worker_finished_=false,retirement_failed_=false;
  bool closing_=false,async_closing_=false;
  std::exception_ptr operation_error_,retirement_error_;
  std::shared_ptr<AsyncPlayback> keepalive_;
};
}  // namespace mtai::avatar
#endif

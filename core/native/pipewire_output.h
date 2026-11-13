#ifndef MTAI_PIPEWIRE_OUTPUT_H
#define MTAI_PIPEWIRE_OUTPUT_H
#include "pcm_custody.h"
#include <pipewire/pipewire.h>
#include <atomic>
#include <memory>

namespace mtai::avatar {
// One serialized nonRT control worker owns these synchronous operations. It is
// NOT libuv's receive thread, the PW mainloop or the RT processing loop. The
// worker and this owner remain alive until close joins. Notify only schedules
// later collection (e.g. uv_async); never enters JS or reenters control APIs.
class PipewireOutput {
 public:
  PipewireOutput(Target target,Layout layout,PcmCustody::Notify notify,void* data);
  ~PipewireOutput();
  PipewireOutput(const PipewireOutput&)=delete;
  PipewireOutput& operator=(const PipewireOutput&)=delete;
  void open(); // actual format/buffers/usable state acceptance
  void submit(ResolvedFrame frame); // already B-eligible, never reschedules
  std::vector<PcmCompletion> collect();
  void stop(const Target& target,const std::string& turn);
  void end_and_drain(); // whole attachment only, actual drained event
  void close(); // actual custody+stream+thread-loop join; repeatable
 private:
  struct BufferInfo {bool usable;};
  struct Invocation {PcmCustody::Command command;void* data;};
  void barrier(PcmCustody::Command,void*);
  void check();
  void signal() noexcept;
  void failure(int error) noexcept;
  void wait_paused();
  void process() noexcept;
  void accept_buffer(pw_buffer*);
  static int invoked(spa_loop*,bool,uint32_t,const void*,size_t,void*) noexcept;
  static void completed(void*) noexcept;
  static void event(void*,uint64_t) noexcept;
  static void state(void*,pw_stream_state,pw_stream_state,const char*) noexcept;
  static void format(void*,uint32_t,const spa_pod*) noexcept;
  static void added(void*,pw_buffer*) noexcept;
  static void removed(void*,pw_buffer*) noexcept;
  static void processing(void*) noexcept;
  static void drained(void*) noexcept;
  static pw_stream_events callbacks();
  Target target_;Layout layout_;
  PcmCustody::Notify notify_;void* notify_data_;
  pw_thread_loop* loop_=nullptr;pw_stream* stream_=nullptr;spa_source* completion_event_=nullptr;
  std::unique_ptr<PcmCustody> custody_;
  pw_stream_events callbacks_{};
  pw_stream_state state_=PW_STREAM_STATE_UNCONNECTED;
  size_t usable_buffers_=0;
  bool started_=false,connected_=false,format_ready_=false,opened_=false,ended_=false,drained_=false,closed_=false;
  std::atomic<int> error_{0};
};
}  // namespace mtai::avatar
#endif

#ifndef MTAI_PCM_CUSTODY_H
#define MTAI_PCM_CUSTODY_H
#include "local_media_state.h"
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <vector>

namespace mtai::avatar {
struct PcmIdentity {
  Target target;uint64_t sequence,sample_start,sample_count;
  std::optional<std::string> turn;
};
enum class PcmDisposition { copied, cancelled };
struct PcmCompletion { PcmIdentity identity;PcmDisposition disposition; };
// Serialized nonRT control owner; process() is called exclusively by one RT
// processing loop. The barrier executes a command on that same processing loop
// synchronously, exactly once before successful return; no process overlaps it.
// Barrier must not throw after executing a command. Production adapter will use
// pw_loop_invoke from off-loop work, NOT pw_thread_loop_lock as a substitute.
class PcmCustody {
 public:
  using Command=void(*)(void*) noexcept;
  using Barrier=std::function<void(Command,void*)>;
  // Availability signal only: must not reenter control APIs or call JS, even
  // when invoked offRT for empty/cancelled blocks. Collection is scheduled later.
  using Notify=void(*)(void*) noexcept;
  PcmCustody(Target target,uint16_t channels,Barrier barrier,Notify notify,void* notify_data);
  ~PcmCustody();
  PcmCustody(const PcmCustody&)=delete;
  PcmCustody& operator=(const PcmCustody&)=delete;
  void submit(ResolvedFrame frame);
  // Actual writable capacity and requested frames come from pw_buffer. Zero
  // requested means no suggestion. Returns bytes copied, never pads invented PCM.
  size_t process(uint8_t* destination,size_t capacity,uint64_t requested_frames) noexcept;
  std::vector<PcmCompletion> collect();
  void begin_stop(const Target& target,const std::string& turn);
  bool whole_stream_flush_permitted() const;
  // Called ONLY after an actual whole-stream flush/drain, while suspended.
  void stream_reset_completed();
  void resume();
  void end();
  bool handoff_complete();
  void close();
 private:
  struct Scope {bool handed=false;};
  struct Block {
    PcmIdentity identity;std::vector<uint8_t> bytes;Scope* scope;
    size_t offset=0;Block* next=nullptr;PcmDisposition disposition=PcmDisposition::copied;
  };
  struct Chain {
    Block* head=nullptr;Block* tail=nullptr;
    void append(Block*) noexcept;
    void append(Chain&) noexcept;
    Block* pop() noexcept;
  };
  void complete(Block*,PcmDisposition) noexcept;
  void suspend();
  static void suspend_command(void*) noexcept;
  static void resume_command(void*) noexcept;
  static void append_command(void*) noexcept;
  static void collect_command(void*) noexcept;
  struct Transfer {PcmCustody* owner;Chain chain;};
  Target target_;size_t frame_bytes_;
  Barrier barrier_;Notify notify_;void* notify_data_;
  bool suspended_=false,ended_=false,closed_=false;
  std::map<std::optional<std::string>,Scope> scopes_;
  std::set<std::string> cancelled_;
  Chain active_,completed_; // RT-only except inside barrier / while suspended
  Chain pending_,retired_;  // nonRT-only
};
}  // namespace mtai::avatar
#endif

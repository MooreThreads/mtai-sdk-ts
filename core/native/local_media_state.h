#ifndef MTAI_LOCAL_MEDIA_STATE_H
#define MTAI_LOCAL_MEDIA_STATE_H
#include "local_media_protocol.h"
#include "playback_clock.h"
#include <map>

namespace mtai::avatar {
struct EffectiveState { std::optional<std::string> turn;bool audio_active; };
struct ResolvedFrame {
  Target target;
  Frame frame;
  EffectiveState state;
  PhaseDecision phase;
};
// Metadata resolution + receipt-time B decision only. Neither actual native
// acceptance, playback/frameApplied, audio handoff nor safe-reuse ACK occurs.
class OutputResolver {
 public:
  explicit OutputResolver(Target target):target_(std::move(target)) {}
  std::optional<ResolvedFrame> accept(Record record,uint64_t received_ns);
  bool attached() const {return attached_ && !ended_;}
 private:
  Target target_;
  std::optional<Layout> layout_;
  bool attached_=false,ended_=false;
  uint64_t sequence_=0,samples_=0,last_state_=0;
  std::map<uint64_t,EffectiveState> pending_;
  std::optional<EffectiveState> state_;
  PlaybackClock clock_;
};
void validate_layout(const Layout& layout);
// Actual FD extent check, not GPU importer/audio acceptance. Does not consume FD.
void validate_allocation(const Layout& layout,int descriptor);
}  // namespace mtai::avatar
#endif

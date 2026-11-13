#ifndef MTAI_AVATAR_PLAYBACK_CLOCK_H
#define MTAI_AVATAR_PLAYBACK_CLOCK_H

#include <cstdint>
#include <limits>
#include <stdexcept>

namespace mtai::avatar {

struct PhaseDecision {
  uint64_t deadline_ns;
  uint64_t old_deadline_ns;
  uint64_t initial_origin_ns;
  uint64_t origin_ns;
  uint64_t revision;
  uint64_t effective_sequence;
  bool reanchored;
};

// One instance per qualified attachment. The connection validates generation
// before calling receive(). There is deliberately no timer/draw/ACK reanchor,
// reset, startup inventory or negative-recovery control.
class PlaybackClock {
 public:
  static constexpr uint64_t period_ns = 40000000;

  PhaseDecision receive(uint64_t sequence, uint64_t received_ns) {
    if (last_sequence_ == std::numeric_limits<uint64_t>::max() ||
        sequence != last_sequence_ + 1) {
      throw std::invalid_argument("noncontiguous frame sequence");
    }
    uint64_t old_due = received_ns;
    uint64_t next_origin = origin_;
    bool changed = false;
    if (sequence == 1) {
      next_origin = received_ns;
    } else {
      if (sequence - 1 > (std::numeric_limits<uint64_t>::max() - origin_) / period_ns) {
        throw std::overflow_error("phase deadline representation overflow");
      }
      old_due = origin_ + (sequence - 1) * period_ns;
      if (received_ns > old_due) {
        next_origin = received_ns - (sequence - 1) * period_ns;
        changed = true;
      }
    }
    // Commit only after the input/representation checks. A rejected record
    // cannot consume a publication identity or change the scheduling phase.
    origin_ = next_origin;
    if (sequence == 1) initial_origin_ = received_ns;
    if (changed) { ++revision_; effective_sequence_ = sequence; }
    last_sequence_ = sequence;
    return {changed ? received_ns : old_due, old_due, initial_origin_, origin_,
            revision_, effective_sequence_, changed};
  }

 private:
  uint64_t origin_ = 0;
  uint64_t initial_origin_ = 0;
  uint64_t last_sequence_ = 0;
  uint64_t revision_ = 0;
  uint64_t effective_sequence_ = 1;
};

}  // namespace mtai::avatar
#endif

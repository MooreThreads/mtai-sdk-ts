#ifndef MTAI_LOCAL_MEDIA_PROTOCOL_H
#define MTAI_LOCAL_MEDIA_PROTOCOL_H
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace mtai::avatar {
struct ProtocolError : std::runtime_error { using std::runtime_error::runtime_error; };
struct Target {
  std::string session, generation, attachment;
  bool operator==(const Target& other) const {
    return session == other.session && generation == other.generation && attachment == other.attachment;
  }
};
struct Attach {};
struct Layout {
  uint64_t allocation = 0;
  uint32_t width = 0, height = 0, fourcc = 0;
  uint64_t stride = 0, offset = 0, modifier = 0, extent = 0;
  uint8_t row_origin = 0, color_space = 0;
  uint32_t sample_rate = 0;
  uint16_t channels = 0, sample_format = 0;
};
struct Ready { uint64_t allocation; };
struct Attached { uint64_t allocation; };
struct OutputState {
  uint64_t effective_frame;
  bool snapshot;
  std::optional<std::string> turn;
  bool audio_active;
};
struct Frame {
  uint64_t sequence, allocation, renderer_frame, produced_ns, sample_start, sample_count;
  std::vector<uint8_t> pcm;
};
struct ReuseAck {
  uint64_t sequence, allocation, submission_receipt_ns, origin_ns, revision, effective_frame;
};
struct Eos { uint64_t last_sequence, total_samples; };
struct Detach { uint64_t last_sequence; std::string reason; };
struct Failure { uint32_t code; std::string message; };
struct Cancel { uint64_t request, through_sequence; std::optional<std::string> turn; };
struct Retired { uint64_t request, through_sequence; };
// Variant order is the fixed v1 kind identifier minus one.
using Payload = std::variant<Attach, Layout, Ready, Attached, OutputState, Frame,
                             ReuseAck, Eos, Detach, Failure, Cancel, Retired>;
struct Record { Target target; Payload payload; };
std::vector<uint8_t> encode(const Record& record);
Record decode(const std::vector<uint8_t>& bytes);
uint16_t kind(const Record& record);
}  // namespace mtai::avatar
#endif

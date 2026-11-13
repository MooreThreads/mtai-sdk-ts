#include "../playback_clock.h"
#include <cassert>
#include <cstdint>
#include <limits>

using mtai::avatar::PlaybackClock;

template <typename Error, typename Operation>
void rejects(Operation operation) {
  bool rejected = false;
  try { operation(); } catch (const Error&) { rejected = true; }
  assert(rejected);
}

int main() {
  PlaybackClock clock;
  const auto first = clock.receive(1, 17);
  assert(first.deadline_ns == 17 && first.initial_origin_ns == 17);
  assert(first.origin_ns == 17 && first.revision == 0 && !first.reanchored);
  const auto early = clock.receive(2, 20);
  assert(early.deadline_ns == 40000017 && early.origin_ns == 17 && !early.reanchored);
  const auto late = clock.receive(3, 120000023);
  assert(late.old_deadline_ns == 80000017 && late.deadline_ns == 120000023);
  assert(late.origin_ns == 40000023 && late.initial_origin_ns == 17);
  assert(late.revision == 1 && late.effective_sequence == 3 && late.reanchored);
  const auto following = clock.receive(4, 130000000);
  assert(following.deadline_ns == 160000023 && following.origin_ns == 40000023);
  assert(following.revision == 1 && !following.reanchored);  // no C-style recovery
  const auto exact = clock.receive(5, 200000023);
  assert(exact.deadline_ns == 200000023 && !exact.reanchored);
  const auto one_ns_late = clock.receive(6, 240000024);
  assert(one_ns_late.origin_ns == 40000024 && one_ns_late.revision == 2);
  assert(one_ns_late.effective_sequence == 6 && one_ns_late.reanchored);

  PlaybackClock contiguous;
  rejects<std::invalid_argument>([&] { contiguous.receive(0, 1); });
  contiguous.receive(1, 7);
  rejects<std::invalid_argument>([&] { contiguous.receive(1, 8); });
  rejects<std::invalid_argument>([&] { contiguous.receive(3, 9); });
  assert(contiguous.receive(2, 40000007).revision == 0);

  PlaybackClock wide;
  const uint64_t beyond_number_precision = 9007199254740993ULL;
  assert(wide.receive(1, beyond_number_precision).deadline_ns == beyond_number_precision);
  assert(wide.receive(2, beyond_number_precision + 40000000).deadline_ns == beyond_number_precision + 40000000);
  PlaybackClock zero;
  assert(zero.receive(1, 0).deadline_ns == 0);
  assert(zero.receive(2, 40000000).initial_origin_ns == 0);
  PlaybackClock overflow;
  overflow.receive(1, std::numeric_limits<uint64_t>::max() - 1);
  rejects<std::overflow_error>([&] { overflow.receive(2, std::numeric_limits<uint64_t>::max()); });
}

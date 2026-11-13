#include "pcm_custody.h"
#include <algorithm>
#include <cstring>
#include <limits>

namespace mtai::avatar {
void PcmCustody::Chain::append(Block* block) noexcept {
  block->next=nullptr;if(tail)tail->next=block;else head=block;tail=block;
}
void PcmCustody::Chain::append(Chain& chain) noexcept {
  if(!chain.head)return;
  if(tail)tail->next=chain.head;else head=chain.head;tail=chain.tail;chain={};
}
PcmCustody::Block* PcmCustody::Chain::pop() noexcept {
  auto* value=head;if(value){head=value->next;value->next=nullptr;if(!head)tail=nullptr;}return value;
}
PcmCustody::PcmCustody(Target target,uint16_t channels,Barrier barrier,Notify notify,void* data)
  :target_(std::move(target)),frame_bytes_(size_t(channels)*2),barrier_(std::move(barrier)),notify_(notify),notify_data_(data) {
  if(!channels || !barrier_ || !notify_)throw ProtocolError("PCM requires format, processing barrier and RT notifier");
}
PcmCustody::~PcmCustody() {
  // close must run while the processing-loop barrier is alive. Never pretend
  // successful retirement if that owner was abandoned or its barrier failed.
  if(!closed_)std::terminate();
}
void PcmCustody::suspend_command(void* data) noexcept {
  auto& self=*static_cast<PcmCustody*>(data);self.suspended_=true;self.pending_.append(self.active_);
}
void PcmCustody::resume_command(void* data) noexcept {
  auto& self=*static_cast<PcmCustody*>(data);self.active_.append(self.pending_);self.suspended_=false;
}
void PcmCustody::append_command(void* data) noexcept {
  auto& transfer=*static_cast<Transfer*>(data);transfer.owner->active_.append(transfer.chain);
}
void PcmCustody::collect_command(void* data) noexcept {
  auto& self=*static_cast<PcmCustody*>(data);self.retired_.append(self.completed_);
}
void PcmCustody::suspend() {if(!suspended_)barrier_(suspend_command,this);}
void PcmCustody::submit(ResolvedFrame frame) {
  if(closed_ || ended_)throw ProtocolError("PCM admission after terminal fence");
  if(!(frame.target==target_))throw ProtocolError("PCM generation mismatch");
  if(frame.frame.sample_count>std::numeric_limits<uint64_t>::max()/frame_bytes_
      || frame.frame.sample_count*frame_bytes_!=frame.frame.pcm.size())throw ProtocolError("PCM count mismatch");
  auto& scope=scopes_[frame.state.turn];
  auto block=std::make_unique<Block>(Block{PcmIdentity{target_,frame.frame.sequence,frame.frame.sample_start,
    frame.frame.sample_count,frame.state.turn},std::move(frame.frame.pcm),&scope});
  if(frame.state.turn && cancelled_.count(*frame.state.turn)) {
    block->disposition=PcmDisposition::cancelled;retired_.append(block.release());notify_(notify_data_);return;
  }
  if(block->bytes.empty()){retired_.append(block.release());notify_(notify_data_);return;}
  if(suspended_){pending_.append(block.release());return;}
  Transfer transfer{this,{block.get(),block.get()}};
  barrier_(append_command,&transfer);block.release();
}
void PcmCustody::complete(Block* block,PcmDisposition disposition) noexcept {
  block->disposition=disposition;completed_.append(block);
}
size_t PcmCustody::process(uint8_t* destination,size_t capacity,uint64_t requested_frames) noexcept {
  if(suspended_ || !destination)return 0;
  size_t available_frames=capacity/frame_bytes_;
  if(requested_frames && requested_frames<available_frames)available_frames=size_t(requested_frames);
  size_t budget=available_frames*frame_bytes_,copied=0;bool completed=false;
  while(copied<budget && active_.head) {
    auto* block=active_.head;size_t count=std::min(budget-copied,block->bytes.size()-block->offset);
    std::memcpy(destination+copied,block->bytes.data()+block->offset,count);
    block->scope->handed=true;block->offset+=count;copied+=count;
    if(block->offset==block->bytes.size()){complete(active_.pop(),PcmDisposition::copied);completed=true;}
  }
  if(completed)notify_(notify_data_);
  return copied;
}
std::vector<PcmCompletion> PcmCustody::collect() {
  if(!closed_)barrier_(collect_command,this);
  std::vector<PcmCompletion> output;
  for(auto* block=retired_.head;block;block=block->next)
    output.push_back(PcmCompletion{block->identity,block->disposition});
  // No ownership consumed until every fallible output copy has succeeded.
  while(auto* block=retired_.pop())delete block;
  return output;
}
void PcmCustody::begin_stop(const Target& target,const std::string& turn) {
  if(closed_)throw ProtocolError("stop after PCM close");
  if(!(target==target_))throw ProtocolError("stop generation mismatch");
  cancelled_.insert(turn);suspend();
  Chain retained;bool pruned=false;
  while(auto* block=pending_.pop()) {
    if(block->identity.turn && cancelled_.count(*block->identity.turn)) {
      block->disposition=PcmDisposition::cancelled;retired_.append(block);pruned=true;
    }else retained.append(block);
  }
  pending_.append(retained);
  if(pruned)notify_(notify_data_);
}
bool PcmCustody::whole_stream_flush_permitted() const {
  if(closed_ || !suspended_)throw ProtocolError("flush decision outside RT barrier");
  for(const auto& entry:scopes_)if(entry.second.handed && (!entry.first || !cancelled_.count(*entry.first)))return false;
  return true;
}
void PcmCustody::stream_reset_completed() {
  if(!whole_stream_flush_permitted())throw ProtocolError("protected PCM forbids whole-stream reset");
  for(auto& entry:scopes_)entry.second.handed=false;
}
void PcmCustody::resume() {
  if(closed_)throw ProtocolError("resume after PCM close");
  if(suspended_)barrier_(resume_command,this);
}
void PcmCustody::end() {
  if(closed_)throw ProtocolError("EOS after PCM close");
  ended_=true;
}
bool PcmCustody::handoff_complete() {
  if(!ended_ || closed_)return false;
  bool was_suspended=suspended_;suspend();bool empty=!pending_.head;
  if(!was_suspended)resume();
  return empty;
}
void PcmCustody::close() {
  if(closed_)return;
  ended_=true;suspend();barrier_(collect_command,this);
  while(auto* block=pending_.pop()){block->disposition=PcmDisposition::cancelled;retired_.append(block);}
  // Reclaim after quiescence; no callbacks can retain these blocks now.
  while(auto* block=retired_.pop())delete block;
  closed_=true;
}
}  // namespace mtai::avatar

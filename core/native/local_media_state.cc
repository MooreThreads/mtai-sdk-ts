#include "local_media_state.h"
#include <limits>
#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#include <system_error>

namespace mtai::avatar {
namespace {
void require(bool ok,const char* message){if(!ok)throw ProtocolError(message);}
constexpr uint64_t maximum=std::numeric_limits<uint64_t>::max();
}
void validate_layout(const Layout& p) {
  require(p.allocation && p.width && p.height && p.sample_rate && p.channels && p.sample_format==1
          && p.fourcc==0x34324241 && p.color_space==1 && (p.row_origin==1||p.row_origin==2),"unsupported media layout");
  uint64_t row=uint64_t(p.width)*4;
  require(p.stride>=row && p.offset<=p.extent && row<=p.extent-p.offset,"image does not fit allocation");
  require(uint64_t(p.height-1)<=(p.extent-p.offset-row)/p.stride,"image does not fit allocation");
}
void validate_allocation(const Layout& p,int descriptor) {
  validate_layout(p);struct stat info{};
  if(fstat(descriptor,&info))throw std::system_error(errno,std::generic_category(),"allocation fstat");
  // DMA-BUF exporters may expose size through SEEK_END rather than st_size.
  off_t extent=info.st_size;
  if(extent==0){extent=lseek(descriptor,0,SEEK_END);if(extent<0)throw std::system_error(errno,std::generic_category(),"allocation extent");}
  require(extent>=0 && uint64_t(extent)>=p.extent,"descriptor is smaller than allocation layout");
}
std::optional<ResolvedFrame> OutputResolver::accept(Record record,uint64_t received_ns) {
  if(!(record.target==target_))return {};
  require(!ended_,"attachment has ended");
  if(auto* p=std::get_if<Layout>(&record.payload)) {
    require(!layout_,"duplicate layout");validate_layout(*p);layout_=*p;return {};
  }
  if(auto* p=std::get_if<Attached>(&record.payload)) {
    require(layout_ && !attached_ && p->allocation==layout_->allocation,"unmatched attachment");attached_=true;return {};
  }
  if(auto* p=std::get_if<OutputState>(&record.payload)) {
    require(attached_,"state before attachment");
    require(p->effective_frame>sequence_ && p->effective_frame>last_state_
      && (last_state_? !p->snapshot : p->snapshot && p->effective_frame==1),"invalid effective output state");
    pending_.emplace(p->effective_frame,EffectiveState{std::move(p->turn),p->audio_active});last_state_=p->effective_frame;return {};
  }
  if(auto* p=std::get_if<Frame>(&record.payload)) {
    require(layout_ && attached_ && p->allocation==layout_->allocation,"frame before matching attachment");
    require(sequence_!=maximum && p->sequence==sequence_+1 && p->sample_start==samples_,"noncontiguous frame/sample identity");
    uint64_t bytes_per_frame=uint64_t(layout_->channels)*2;
    require(p->sample_count<=maximum/bytes_per_frame && p->pcm.size()==p->sample_count*bytes_per_frame,"PCM format/count mismatch");
    require(p->sample_count<=maximum-samples_,"sample cursor representation overflow");
    auto found=pending_.find(p->sequence);
    auto effective=found==pending_.end()?state_:std::optional<EffectiveState>(found->second);
    require(effective.has_value(),"missing initial output state");
    auto phase=clock_.receive(p->sequence,received_ns);
    sequence_=p->sequence;samples_+=p->sample_count;state_=effective;
    if(found!=pending_.end())pending_.erase(found);
    return ResolvedFrame{target_,std::move(*p),*effective,phase};
  }
  if(auto* p=std::get_if<Eos>(&record.payload)) {
    require(attached_ && p->last_sequence==sequence_ && p->total_samples==samples_,"unmatched EOS");
    ended_=true;pending_.clear();return {};
  }
  if(std::holds_alternative<Detach>(record.payload)||std::holds_alternative<Failure>(record.payload)) {
    ended_=true;pending_.clear();return {};
  }
  throw ProtocolError("record requires native control owner");
}
}  // namespace mtai::avatar

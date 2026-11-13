#include "local_media_protocol.h"
#include <limits>
#include <type_traits>

namespace mtai::avatar {
namespace {
void require(bool ok, const char* message) { if (!ok) throw ProtocolError(message); }
void utf8(const std::string& text) {
  for (size_t i=0; i<text.size();) {
    uint8_t lead=uint8_t(text[i++]);
    if (lead<0x80) continue;
    unsigned rest; uint32_t code, minimum;
    if (lead>=0xc2 && lead<=0xdf) { rest=1;code=lead&31;minimum=0x80; }
    else if (lead>=0xe0 && lead<=0xef) { rest=2;code=lead&15;minimum=0x800; }
    else if (lead>=0xf0 && lead<=0xf4) { rest=3;code=lead&7;minimum=0x10000; }
    else throw ProtocolError("invalid UTF-8");
    require(rest<=text.size()-i,"truncated UTF-8");
    for (unsigned n=0;n<rest;n++) {
      uint8_t byte=uint8_t(text[i++]); require((byte&0xc0)==0x80,"invalid UTF-8 continuation");
      code=(code<<6)|(byte&63);
    }
    require(code>=minimum && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff),"invalid UTF-8 scalar");
  }
}
struct Writer {
  std::vector<uint8_t> bytes;
  template<class T> void integer(T value) {
    static_assert(std::is_unsigned_v<T>);
    for(size_t i=0;i<sizeof(T);i++) bytes.push_back(uint8_t(value>>(i*8)));
  }
  void boolean(bool value) { integer<uint8_t>(value?1:0); }
  void string(const std::string& value) {
    utf8(value);require(value.size()<=std::numeric_limits<uint32_t>::max(),"string length representation");
    integer<uint32_t>(uint32_t(value.size()));bytes.insert(bytes.end(),value.begin(),value.end());
  }
  void optional(const std::optional<std::string>& value) { boolean(value.has_value());if(value) string(*value); }
  void blob(const std::vector<uint8_t>& value) {
    integer<uint64_t>(value.size());bytes.insert(bytes.end(),value.begin(),value.end());
  }
};
struct Reader {
  const std::vector<uint8_t>& bytes;size_t offset=0;
  size_t take(uint64_t count) {
    require(count<=bytes.size()-offset,"truncated record");size_t start=offset;offset+=size_t(count);return start;
  }
  template<class T> T integer() {
    static_assert(std::is_unsigned_v<T>);size_t at=take(sizeof(T));T value=0;
    for(size_t i=0;i<sizeof(T);i++) value|=T(T(bytes[at+i])<<(i*8));
    return value;
  }
  bool boolean() { auto v=integer<uint8_t>();require(v<=1,"invalid boolean");return v!=0; }
  std::string string() {
    auto length=integer<uint32_t>();auto at=take(length);
    std::string result(bytes.begin()+at,bytes.begin()+at+length);utf8(result);return result;
  }
  std::optional<std::string> optional() { if(!boolean())return {};return string(); }
  std::vector<uint8_t> blob() {
    auto length=integer<uint64_t>();auto at=take(length);
    return {bytes.begin()+at,bytes.begin()+at+size_t(length)};
  }
};
void fields(Writer&,const Attach&) {}
void fields(Writer& w,const Layout& p) {
  w.integer(p.allocation);w.integer(p.width);w.integer(p.height);w.integer(p.fourcc);
  w.integer(p.stride);w.integer(p.offset);w.integer(p.modifier);w.integer(p.extent);
  w.integer(p.row_origin);w.integer(p.color_space);w.integer(p.sample_rate);w.integer(p.channels);w.integer(p.sample_format);
}
void fields(Writer& w,const Ready& p) { w.integer(p.allocation); }
void fields(Writer& w,const Attached& p) { w.integer(p.allocation); }
void fields(Writer& w,const OutputState& p) {
  w.integer(p.effective_frame);w.boolean(p.snapshot);w.optional(p.turn);w.boolean(p.audio_active);
}
void fields(Writer& w,const Frame& p) {
  w.integer(p.sequence);w.integer(p.allocation);w.integer(p.renderer_frame);w.integer(p.produced_ns);
  w.integer(p.sample_start);w.integer(p.sample_count);w.blob(p.pcm);
}
void fields(Writer& w,const ReuseAck& p) {
  w.integer(p.sequence);w.integer(p.allocation);w.integer(p.submission_receipt_ns);
  w.integer(p.origin_ns);w.integer(p.revision);w.integer(p.effective_frame);
}
void fields(Writer& w,const Eos& p) { w.integer(p.last_sequence);w.integer(p.total_samples); }
void fields(Writer& w,const Detach& p) { w.integer(p.last_sequence);w.string(p.reason); }
void fields(Writer& w,const Failure& p) { w.integer(p.code);w.string(p.message); }
void fields(Writer& w,const Cancel& p) { w.integer(p.request);w.integer(p.through_sequence);w.optional(p.turn); }
void fields(Writer& w,const Retired& p) { w.integer(p.request);w.integer(p.through_sequence); }
Payload payload(Reader& r,uint16_t code) {
  switch(code) {
    case 1:return Attach{};
    case 2:{ Layout p;p.allocation=r.integer<uint64_t>();p.width=r.integer<uint32_t>();p.height=r.integer<uint32_t>();p.fourcc=r.integer<uint32_t>();
      p.stride=r.integer<uint64_t>();p.offset=r.integer<uint64_t>();p.modifier=r.integer<uint64_t>();p.extent=r.integer<uint64_t>();
      p.row_origin=r.integer<uint8_t>();p.color_space=r.integer<uint8_t>();p.sample_rate=r.integer<uint32_t>();
      p.channels=r.integer<uint16_t>();p.sample_format=r.integer<uint16_t>();return p; }
    case 3:return Ready{r.integer<uint64_t>()};
    case 4:return Attached{r.integer<uint64_t>()};
    case 5:{ auto frame=r.integer<uint64_t>();auto snapshot=r.boolean();auto turn=r.optional();auto active=r.boolean();return OutputState{frame,snapshot,turn,active}; }
    case 6:{ Frame p;p.sequence=r.integer<uint64_t>();p.allocation=r.integer<uint64_t>();p.renderer_frame=r.integer<uint64_t>();p.produced_ns=r.integer<uint64_t>();
      p.sample_start=r.integer<uint64_t>();p.sample_count=r.integer<uint64_t>();p.pcm=r.blob();return p; }
    case 7:return ReuseAck{r.integer<uint64_t>(),r.integer<uint64_t>(),r.integer<uint64_t>(),r.integer<uint64_t>(),r.integer<uint64_t>(),r.integer<uint64_t>()};
    case 8:return Eos{r.integer<uint64_t>(),r.integer<uint64_t>()};
    case 9:{ auto last=r.integer<uint64_t>();return Detach{last,r.string()}; }
    case 10:{ auto code_value=r.integer<uint32_t>();return Failure{code_value,r.string()}; }
    case 11:{ auto request=r.integer<uint64_t>();auto through=r.integer<uint64_t>();return Cancel{request,through,r.optional()}; }
    case 12:return Retired{r.integer<uint64_t>(),r.integer<uint64_t>()};
    default:throw ProtocolError("unsupported record kind");
  }
}
}
uint16_t kind(const Record& record) { return uint16_t(record.payload.index()+1); }
std::vector<uint8_t> encode(const Record& record) {
  Writer body;body.string(record.target.session);body.string(record.target.generation);body.string(record.target.attachment);
  std::visit([&](const auto& p){ fields(body,p); },record.payload);
  Writer header;header.bytes={'D','2','L','M'};header.integer<uint16_t>(1);header.integer(kind(record));header.integer<uint64_t>(body.bytes.size());
  header.bytes.insert(header.bytes.end(),body.bytes.begin(),body.bytes.end());return header.bytes;
}
Record decode(const std::vector<uint8_t>& bytes) {
  Reader r{bytes};require(r.integer<uint32_t>()==0x4d4c3244,"unsupported protocol magic");
  require(r.integer<uint16_t>()==1,"unsupported protocol version");auto code=r.integer<uint16_t>();
  auto length=r.integer<uint64_t>();require(length==bytes.size()-r.offset,"record length mismatch");
  Target target{r.string(),r.string(),r.string()};auto value=payload(r,code);
  require(r.offset==bytes.size(),"trailing record bytes");return {std::move(target),std::move(value)};
}
}  // namespace mtai::avatar

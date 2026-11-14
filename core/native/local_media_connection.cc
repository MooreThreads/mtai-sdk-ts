#include "local_media_connection.h"
#include <limits>
#include <time.h>
#include <system_error>

#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
extern "C" void mtai_test_connection_start(unsigned);
#endif
namespace mtai::avatar {
namespace {
uint64_t now() {
  timespec value{};
  if(clock_gettime(CLOCK_MONOTONIC,&value))throw std::system_error(errno,std::generic_category(),"monotonic clock");
  return uint64_t(value.tv_sec)*1000000000+uint64_t(value.tv_nsec);
}
void checked(int status){if(status<0)throw std::runtime_error(uv_strerror(status));}
}
LocalConnection::LocalConnection(Descriptor socket,Target target,ConnectionEvents events)
  :socket_(std::move(socket)),target_(std::move(target)),events_(std::move(events)),resolver_(target_) {}
std::shared_ptr<LocalConnection> LocalConnection::open(uv_loop_t* loop,Descriptor socket,Target target,ConnectionEvents events) {
  auto owner=std::shared_ptr<LocalConnection>(new LocalConnection(std::move(socket),std::move(target),std::move(events)));
  owner->keepalive_=owner;
  try {owner->start(loop);}catch(const std::exception& error){owner->fail(error.what());}
  return owner;
}
void LocalConnection::start(uv_loop_t* loop) {
#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
  mtai_test_connection_start(0);
#endif
  checked(uv_poll_init(loop,&poll_,socket_.descriptor()));poll_initialized_=true;poll_.data=this;
#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
  mtai_test_connection_start(1);
#endif
  checked(uv_timer_init(loop,&timer_));timer_initialized_=true;timer_.data=this;
  writes_.push_back({target_,Attach{}});write();
}
void LocalConnection::accept_layout(uint64_t allocation) {
  if(closing_)throw ProtocolError("acceptance after close");
  if(!layout_ || accepted_ || layout_->allocation!=allocation)throw ProtocolError("unmatched native acceptance");
  accepted_=true;send_control({target_,Ready{allocation}});
}
void LocalConnection::send_control(Record record) {
  if(closing_ || eof_)throw ProtocolError("send after connection close");
  if(!(record.target==target_))throw ProtocolError("outgoing target mismatch");
  if(!std::holds_alternative<Ready>(record.payload) && !std::holds_alternative<ReuseAck>(record.payload)
     && !std::holds_alternative<Detach>(record.payload) && !std::holds_alternative<Failure>(record.payload))
    throw ProtocolError("unsupported outgoing control");
  if(auto* ready=std::get_if<Ready>(&record.payload))
    if(!accepted_ || !layout_ || ready->allocation!=layout_->allocation)throw ProtocolError("READY without native acceptance");
  writes_.push_back(std::move(record));
  try {write();}catch(const std::exception& error){fail(error.what());}
}
void LocalConnection::write() {
  while(!closing_ && !eof_ && !writes_.empty()) {
    try {
      if(!socket_.send(writes_.front()))break;
    }catch(const std::system_error& error) {
      // An orderly peer close can first become visible as EPIPE on a pending
      // control. Only actual read-side EOF after accepted EOS preserves media.
      if(error.code().value()!=EPIPE || !eos_received_)throw;
      auto received=socket_.receive();
      if(received.status!=ReceiveResult::Status::closed)throw;
      orderly_eof();return;
    }
    writes_.pop_front();
  }
  if(!closing_ && !eof_)checked(uv_poll_start(&poll_,UV_READABLE|(writes_.empty()?0:UV_WRITABLE),polled));
}
void LocalConnection::poll(int status,int events) {
  checked(status);if(closing_)return;
  if(events&UV_WRITABLE)write();
  if(closing_)return;
  if(events&UV_READABLE) {
    while(!closing_ && !eof_) {
      auto received=socket_.receive();
      if(received.status==ReceiveResult::Status::would_block)break;
      if(received.status==ReceiveResult::Status::closed) {
        orderly_eof();
        break;
      }
      consume(std::move(*received.value));
    }
  }
}
void LocalConnection::orderly_eof() {
  if(!eos_received_)throw ProtocolError("producer disconnected before EOS");
  eof_=true;writes_.clear();checked(uv_poll_stop(&poll_));
  // Keep B-gated media and final EOS signal; undeliverable controls are not
  // acknowledged. Socket/handles retire only through explicit joined close.
}
void LocalConnection::consume(Received received) {
  if(!(received.record.target==target_))return;
  if(auto* value=std::get_if<Layout>(&received.record.payload)) {
    validate_allocation(*value,received.descriptor.get());resolver_.accept(received.record,received.received_ns);
    layout_=*value;
    if(!events_.layout)throw ProtocolError("missing actual native acceptance owner");
    events_.layout(*value,std::move(received.descriptor));return;
  }
  if(std::holds_alternative<Attached>(received.record.payload)) {
    if(!accepted_)throw ProtocolError("ATTACHED before actual native acceptance");
    resolver_.accept(std::move(received.record),received.received_ns);
    if(events_.attached)events_.attached();
    return;
  }
  if(auto* failure=std::get_if<Failure>(&received.record.payload))throw ProtocolError(failure->message);
  if(auto* detach=std::get_if<Detach>(&received.record.payload))throw ProtocolError("producer detached: "+detach->reason);
  bool eos=std::holds_alternative<Eos>(received.record.payload);
  auto resolved=resolver_.accept(std::move(received.record),received.received_ns);
  if(resolved)frames_.push_back(std::move(*resolved));
  if(eos)eos_received_=true;
  deliver();
}
void LocalConnection::deliver() {
  if(closing_)return;
  checked(uv_timer_stop(&timer_));
  while(!closing_ && !frames_.empty() && frames_.front().phase.deadline_ns<=now()) {
    auto frame=std::move(frames_.front());frames_.pop_front();
    if(events_.eligible)events_.eligible(std::move(frame));
  }
  if(closing_)return;
  if(eos_received_ && frames_.empty() && !eos_emitted_) {
    eos_emitted_=true;if(events_.eos)events_.eos();
  }
  if(!closing_)arm();
}
void LocalConnection::arm() {
  if(frames_.empty())return;
  uint64_t current=now(),due=frames_.front().phase.deadline_ns;
  uint64_t remaining=due>current?due-current:0;
  // uv timers have millisecond resolution; ceil is an eligibility wakeup,
  // never a new phase anchor. Callback rechecks CLOCK_MONOTONIC before release.
  uint64_t milliseconds=remaining/1000000+(remaining%1000000!=0);
  uv_update_time(timer_.loop);
  checked(uv_timer_start(&timer_,timed,milliseconds,0));
}
void LocalConnection::fail(const std::string& message) noexcept {
  if(closing_)return;
  // Fence before external callback; reentrant close cannot emit twice.
  close();
  try {if(events_.failure)events_.failure(message);}catch(...) {}
}
void LocalConnection::close() {
  if(closing_)return;
  closing_=true;writes_.clear();frames_.clear();
  if(poll_initialized_){uv_poll_stop(&poll_);++closing_handles_;uv_close(reinterpret_cast<uv_handle_t*>(&poll_),retired);}
  if(timer_initialized_){uv_timer_stop(&timer_);++closing_handles_;uv_close(reinterpret_cast<uv_handle_t*>(&timer_),retired);}
  // Do not release/reuse the fd while uv_poll is still retiring.
  if(!closing_handles_)close_handle();
}
void LocalConnection::close_handle() {
  if(closing_handles_)--closing_handles_;
  if(closing_handles_)return;
  auto lifetime=std::move(keepalive_);socket_.close();
  try{if(events_.closed)events_.closed();}catch(...) {}
}
void LocalConnection::polled(uv_poll_t* handle,int status,int events) noexcept {
  auto* self=static_cast<LocalConnection*>(handle->data);auto lifetime=self->keepalive_;
  try{self->poll(status,events);}catch(const std::exception& error){self->fail(error.what());}catch(...){self->fail("native callback failure");}
}
void LocalConnection::timed(uv_timer_t* handle) noexcept {
  auto* self=static_cast<LocalConnection*>(handle->data);auto lifetime=self->keepalive_;
  try{self->deliver();}catch(const std::exception& error){self->fail(error.what());}catch(...){self->fail("native callback failure");}
}
void LocalConnection::retired(uv_handle_t* handle) noexcept {static_cast<LocalConnection*>(handle->data)->close_handle();}
}  // namespace mtai::avatar

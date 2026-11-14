#include "async_playback.h"
#include <type_traits>

#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
extern "C" void mtai_test_thread_start();
#endif
namespace mtai::avatar {
AsyncPlayback::AsyncPlayback(Target target,Layout layout,PlaybackEvents events)
 :output_(std::move(target),layout,notify,this),events_(std::move(events)){}
std::shared_ptr<AsyncPlayback> AsyncPlayback::open(uv_loop_t* loop,Target target,Layout layout,PlaybackEvents events){
  auto owner=std::shared_ptr<AsyncPlayback>(new AsyncPlayback(std::move(target),layout,std::move(events)));
  int status=uv_async_init(loop,&owner->async_,awakened);
  if(status<0){owner->output_.close();throw std::runtime_error(uv_strerror(status));}
  owner->async_.data=owner.get();owner->keepalive_=owner;
  try{
#ifdef MTAI_PIPEWIRE_NODE_FIXTURE
    mtai_test_thread_start();
#endif
    owner->worker_=std::thread([self=owner.get()]{self->run();});}
  catch(...){
    // Once uv is initialized return an owned failing instance; its caller can
    // retain environment cleanup until the actual asynchronous retirement.
    {std::lock_guard<std::mutex> lock(owner->mutex_);owner->operation_error_=std::current_exception();owner->close_requested_=true;}
    try{owner->output_.close();}catch(...){std::terminate();} // unopened resource-free owner
    {std::lock_guard<std::mutex> lock(owner->mutex_);owner->worker_finished_=true;}
    uv_async_send(&owner->async_);
  }
  return owner;
}
void AsyncPlayback::enqueue(Command command){
  if(closing_)throw ProtocolError("playback admission after close");
  std::lock_guard<std::mutex> lock(mutex_);
  if(close_requested_ || worker_finished_ || retirement_failed_)throw ProtocolError("playback no longer accepting");
  commands_.push_back(std::move(command));changed_.notify_one();
}
void AsyncPlayback::submit(ResolvedFrame frame){enqueue(std::move(frame));}
void AsyncPlayback::stop(Target target,std::string turn){enqueue(Stop{std::move(target),std::move(turn)});}
void AsyncPlayback::end(){enqueue(End{});}
void AsyncPlayback::close(){request_close(true);}
void AsyncPlayback::request_close(bool retry){
  if(async_closing_ || (closing_ && !retry))return;
  bool repeated=closing_;closing_=true;
  // Wake PW outside the command mutex: mainloop callback notification takes it.
  {std::lock_guard<std::mutex> lock(mutex_);bool retiring=close_requested_||retirement_failed_;commands_.clear();close_requested_=true;if(retry && (repeated||retiring))retry_requested_=true;changed_.notify_one();}
  output_.request_cancel();
}
void AsyncPlayback::notify(void* data) noexcept {
  auto& self=*static_cast<AsyncPlayback*>(data);
  {std::lock_guard<std::mutex> lock(self.mutex_);self.collect_=true;self.changed_.notify_one();}
}
void AsyncPlayback::post(Event event){
  {std::lock_guard<std::mutex> lock(mutex_);results_.push_back(std::move(event));}
  uv_async_send(&async_);
}
void AsyncPlayback::run() noexcept {
  try{
    output_.open();post(Ready{});
    while(true){
      std::optional<Command> command;bool collect=false;
      {std::unique_lock<std::mutex> lock(mutex_);changed_.wait(lock,[&]{return close_requested_||collect_||!commands_.empty();});
        if(close_requested_)break;
        if(!commands_.empty()){command=std::move(commands_.front());commands_.pop_front();}
        collect=collect_;collect_=false;
      }
      if(command)std::visit([&](auto& value){
        using T=std::decay_t<decltype(value)>;
        if constexpr(std::is_same_v<T,ResolvedFrame>)output_.submit(std::move(value));
        else if constexpr(std::is_same_v<T,Stop>)output_.stop(value.target,value.turn);
        else {output_.end_and_drain();post(Drained{});}
      },*command);
      if(collect){auto completions=output_.collect();if(!completions.empty())post(std::move(completions));}
    }
  }catch(...){
    std::lock_guard<std::mutex> lock(mutex_);
    if(!close_requested_)operation_error_=std::current_exception();
    close_requested_=true;commands_.clear();
  }
  // A failed native retirement keeps both owners alive, reports failure and
  // waits for an explicit close request to retry. Never auto-retry or certify it.
  while(true){
    try{output_.close();break;}
    catch(...){
      {std::lock_guard<std::mutex> lock(mutex_);retirement_failed_=true;retirement_error_=std::current_exception();}
      uv_async_send(&async_);
      std::unique_lock<std::mutex> lock(mutex_);changed_.wait(lock,[&]{return retry_requested_ && !retirement_error_;});retry_requested_=false;retirement_failed_=false;
    }
  }
  {std::lock_guard<std::mutex> lock(mutex_);worker_finished_=true;}
  uv_async_send(&async_);
}
void AsyncPlayback::report(std::exception_ptr error) noexcept {
  // Failure publication itself must never initiate an implicit retry, even if
  // application notification throws (or constructing its string fails).
  try{if(error)std::rethrow_exception(error);}catch(const std::exception& cause){try{if(events_.failed)events_.failed(cause.what());}catch(...) {}}
  catch(...){try{if(events_.failed)events_.failed("native playback failed");}catch(...) {}}
}
void AsyncPlayback::deliver() noexcept {
  std::exception_ptr operation,retirement;bool finished,terminal;
  {std::lock_guard<std::mutex> lock(mutex_);operation=std::move(operation_error_);retirement=std::move(retirement_error_);finished=worker_finished_;terminal=close_requested_||retirement_failed_;changed_.notify_one();}
  if(operation || retirement)closing_=true;
  report(operation);report(retirement);
  while(true){
    std::optional<Event> event;
    {std::lock_guard<std::mutex> lock(mutex_);if(results_.empty())break;event.emplace(std::move(results_.front()));results_.pop_front();}
    if(closing_ || terminal)continue;
    try{
      std::visit([&](auto& value){
        using T=std::decay_t<decltype(value)>;
        if constexpr(std::is_same_v<T,Ready>){if(events_.ready)events_.ready();}
        else if constexpr(std::is_same_v<T,Drained>){if(events_.drained)events_.drained();}
        else {if(events_.completed)events_.completed(std::move(value));}
      },*event);
    }catch(...){
      auto error=std::current_exception();request_close(false);report(error);
    }
  }
  if(finished && !async_closing_){
    closing_=true;if(worker_.joinable())worker_.join();async_closing_=true;
    uv_close(reinterpret_cast<uv_handle_t*>(&async_),retired);
  }
}
void AsyncPlayback::awakened(uv_async_t* handle) noexcept {static_cast<AsyncPlayback*>(handle->data)->deliver();}
void AsyncPlayback::retired(uv_handle_t* handle) noexcept {
  auto& self=*static_cast<AsyncPlayback*>(handle->data);auto lifetime=std::move(self.keepalive_);
  try{if(self.events_.closed)self.events_.closed();}catch(...) {}
}
}  // namespace mtai::avatar

#include <windows.h>
#include <UIAutomation.h>
#include <dwmapi.h>

#include <atomic>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {
std::mutex output_mutex;
std::atomic<bool> running{true};
DWORD message_thread_id = 0;
HHOOK mouse_hook = nullptr;
HHOOK keyboard_hook = nullptr;
std::atomic<bool> launcher_hotkey_enabled{false};
std::atomic<bool> launcher_hotkey_down{false};
std::atomic<bool> launcher_space_suppressed{false};

void emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(output_mutex);
  std::cout << json << std::endl;
}

std::string to_utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                        nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string output(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), bytes,
                      nullptr, nullptr);
  return output;
}

std::string json_escape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          const char* hex = "0123456789abcdef";
          output << "\\u00" << hex[(character >> 4) & 0x0f] << hex[character & 0x0f];
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  return output.str();
}

void foreground_context(std::string& process_path, std::string& title) {
  const HWND window = GetForegroundWindow();
  if (!window) return;

  const int title_length = GetWindowTextLengthW(window);
  if (title_length > 0) {
    std::vector<wchar_t> title_buffer(static_cast<size_t>(title_length) + 1);
    GetWindowTextW(window, title_buffer.data(), static_cast<int>(title_buffer.size()));
    title = to_utf8(title_buffer.data());
  }

  DWORD process_id = 0;
  GetWindowThreadProcessId(window, &process_id);
  if (!process_id) return;
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) return;
  std::vector<wchar_t> path_buffer(32768);
  DWORD path_length = static_cast<DWORD>(path_buffer.size());
  if (QueryFullProcessImageNameW(process, 0, path_buffer.data(), &path_length)) {
    process_path = to_utf8(std::wstring(path_buffer.data(), path_length));
  }
  CloseHandle(process);
}

void respond(const std::string& id, bool ok, const std::string& fields = "") {
  std::ostringstream stream;
  stream << "{\"type\":\"response\",\"id\":\"" << id << "\",\"ok\":"
         << (ok ? "true" : "false");
  if (!fields.empty()) stream << "," << fields;
  stream << "}";
  emit(stream.str());
}

bool send_key_chord(WORD virtual_key) {
  INPUT inputs[4]{};
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_CONTROL;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = virtual_key;
  inputs[2].type = INPUT_KEYBOARD;
  inputs[2].ki.wVk = virtual_key;
  inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
  inputs[3].type = INPUT_KEYBOARD;
  inputs[3].ki.wVk = VK_CONTROL;
  inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
  return SendInput(4, inputs, sizeof(INPUT)) == 4;
}

void focus_window(HWND window) {  if (!window || !IsWindow(window)) return;
  if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
  const HWND foreground = GetForegroundWindow();
  const DWORD foreground_thread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
  const DWORD target_thread = GetWindowThreadProcessId(window, nullptr);
  const DWORD current_thread = GetCurrentThreadId();
  if (foreground_thread && foreground_thread != current_thread) {
    AttachThreadInput(current_thread, foreground_thread, TRUE);
  }
  if (target_thread && target_thread != current_thread) {
    AttachThreadInput(current_thread, target_thread, TRUE);
  }
  BringWindowToTop(window);
  SetForegroundWindow(window);
  SetActiveWindow(window);
  SetFocus(window);
  if (target_thread && target_thread != current_thread) {
    AttachThreadInput(current_thread, target_thread, FALSE);
  }
  if (foreground_thread && foreground_thread != current_thread) {
    AttachThreadInput(current_thread, foreground_thread, FALSE);
  }
}

void disable_window_transitions(HWND window) {
  if (!window || !IsWindow(window)) return;
  // Disable the DWM fade-in animation; otherwise a transparent launcher briefly
  // appears semi-transparent when Electron calls show().
  BOOL disabled = TRUE;
  DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED, &disabled, sizeof(disabled));
}

std::string read_selected_text() {
  const HRESULT initialization = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool should_uninitialize = SUCCEEDED(initialization);
  IUIAutomation* automation = nullptr;
  IUIAutomationElement* focused = nullptr;
  IUIAutomationTextPattern* pattern = nullptr;
  IUIAutomationTextRangeArray* ranges = nullptr;
  std::wstring selected;

  if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_PPV_ARGS(&automation))) &&
      SUCCEEDED(automation->GetFocusedElement(&focused)) && focused &&
      SUCCEEDED(focused->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) &&
      pattern && SUCCEEDED(pattern->GetSelection(&ranges)) && ranges) {
    int length = 0;
    ranges->get_Length(&length);
    for (int index = 0; index < length; ++index) {
      IUIAutomationTextRange* range = nullptr;
      if (FAILED(ranges->GetElement(index, &range)) || !range) continue;
      BSTR text = nullptr;
      if (SUCCEEDED(range->GetText(-1, &text)) && text) {
        if (!selected.empty()) selected.append(L"\n");
        selected.append(text, SysStringLen(text));
        SysFreeString(text);
      }
      range->Release();
    }
  }

  if (ranges) ranges->Release();
  if (pattern) pattern->Release();
  if (focused) focused->Release();
  if (automation) automation->Release();
  if (should_uninitialize) CoUninitialize();
  return to_utf8(selected);
}

struct WindowRecord {
  HWND hwnd;
  std::string title;
  DWORD pid;
  std::string process;
};

BOOL CALLBACK enum_windows_proc(HWND window, LPARAM data) {
  auto* records = reinterpret_cast<std::vector<WindowRecord>*>(data);
  if (records->size() >= 200) return FALSE;
  if (!IsWindowVisible(window)) return TRUE;
  const int title_length = GetWindowTextLengthW(window);
  if (title_length <= 0) return TRUE;
  const LONG_PTR ex_style = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if (ex_style & WS_EX_TOOLWINDOW) return TRUE;

  BOOL cloaked = FALSE;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) &&
      cloaked) {
    return TRUE;
  }

  wchar_t class_name[256]{};
  if (GetClassNameW(window, class_name, 256) > 0) {
    const std::wstring name(class_name);
    if (name == L"Progman" || name == L"WorkerW") return TRUE;
  }

  std::vector<wchar_t> title_buffer(static_cast<size_t>(title_length) + 1);
  GetWindowTextW(window, title_buffer.data(), static_cast<int>(title_buffer.size()));

  DWORD process_id = 0;
  GetWindowThreadProcessId(window, &process_id);
  std::string process_path;
  if (process_id) {
    const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
    if (process) {
      std::vector<wchar_t> path_buffer(32768);
      DWORD path_length = static_cast<DWORD>(path_buffer.size());
      if (QueryFullProcessImageNameW(process, 0, path_buffer.data(), &path_length)) {
        process_path = to_utf8(std::wstring(path_buffer.data(), path_length));
      }
      CloseHandle(process);
    }
  }

  records->push_back({window, to_utf8(title_buffer.data()), process_id, process_path});
  return TRUE;
}

std::string enumerate_windows_json() {
  std::vector<WindowRecord> records;
  EnumWindows(enum_windows_proc, reinterpret_cast<LPARAM>(&records));
  std::ostringstream stream;
  stream << "\"windows\":[";
  bool first = true;
  for (const auto& record : records) {
    if (!first) stream << ',';
    first = false;
    stream << "{\"hwnd\":\"" << reinterpret_cast<ULONG_PTR>(record.hwnd) << "\",\"title\":\""
           << json_escape(record.title) << "\",\"pid\":" << record.pid << ",\"process\":\""
           << json_escape(record.process) << "\"}";
  }
  stream << "]";
  return stream.str();
}

bool send_media_key(WORD virtual_key) {
  INPUT inputs[2]{};
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = virtual_key;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = virtual_key;
  inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
  return SendInput(2, inputs, sizeof(INPUT)) == 2;
}


LRESULT CALLBACK mouse_proc(int code, WPARAM event, LPARAM data) {
  if (code == HC_ACTION && (event == WM_MBUTTONDOWN || event == WM_MBUTTONUP)) {
    const auto* info = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    std::string process_path;
    std::string title;
    foreground_context(process_path, title);
    std::ostringstream stream;
    stream << "{\"type\":\"mouse\",\"button\":\"middle\",\"action\":\""
           << (event == WM_MBUTTONDOWN ? "down" : "up") << "\",\"x\":"
           << info->pt.x << ",\"y\":" << info->pt.y << ",\"time\":"
           << info->time << ",\"process\":\"" << json_escape(process_path)
           << "\",\"title\":\"" << json_escape(title) << "\"}";
    emit(stream.str());
  }
  return CallNextHookEx(mouse_hook, code, event, data);
}

LRESULT CALLBACK keyboard_proc(int code, WPARAM event, LPARAM data) {
  if (code == HC_ACTION && launcher_hotkey_enabled) {
    const auto* info = reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    const bool is_space = info->vkCode == VK_SPACE;
    const bool is_alt =
        info->vkCode == VK_MENU || info->vkCode == VK_LMENU || info->vkCode == VK_RMENU;
    const bool is_down = event == WM_KEYDOWN || event == WM_SYSKEYDOWN;
    const bool is_up = event == WM_KEYUP || event == WM_SYSKEYUP;
    const bool alt_down = (info->flags & LLKHF_ALTDOWN) != 0 ||
                          (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
    if (is_space && is_down && alt_down) {
      launcher_hotkey_down = true;
      launcher_space_suppressed = true;
      return 1;
    }
    if (is_space && is_up && launcher_space_suppressed.exchange(false)) return 1;
    if (is_alt && is_up && launcher_hotkey_down.exchange(false)) {
      emit("{\"type\":\"hotkey\",\"name\":\"launcher\"}");
    }
  }
  return CallNextHookEx(keyboard_hook, code, event, data);
}

void command_loop() {
  std::string line;
  while (running && std::getline(std::cin, line)) {
    std::istringstream input(line);
    std::string command;
    std::string id;
    std::string value;
    input >> command >> id >> value;
    if (command == "seq") {
      respond(id, true, "\"sequence\":" + std::to_string(GetClipboardSequenceNumber()));
    } else if (command == "copy") {
      respond(id, send_key_chord('C'));
    } else if (command == "copyinsert") {
      respond(id, send_key_chord(VK_INSERT));
    } else if (command == "paste") {
      respond(id, send_key_chord('V'));
    } else if (command == "selection") {
      const std::string text = read_selected_text();
      respond(id, true, "\"text\":\"" + json_escape(text) + "\"");
    } else if (command == "windows") {
      respond(id, true, enumerate_windows_json());
    } else if (command == "media") {
      WORD key = 0;
      if (value == "mute") key = VK_VOLUME_MUTE;
      else if (value == "up") key = VK_VOLUME_UP;
      else if (value == "down") key = VK_VOLUME_DOWN;
      respond(id, key != 0 && send_media_key(key));
    } else if (command == "hotkey") {
      launcher_hotkey_enabled = value == "1";
      if (!launcher_hotkey_enabled) {
        launcher_hotkey_down = false;
        launcher_space_suppressed = false;
      }
      respond(id, true);
    } else if (command == "focus") {
      HWND window = nullptr;
      try {
        window = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(std::stoull(value)));
      } catch (...) {
        window = nullptr;
      }
      focus_window(window);
      respond(id, window && IsWindow(window) ? true : false);
    } else if (command == "prepare") {
      HWND window = nullptr;
      try {
        window = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(std::stoull(value)));
      } catch (...) {
        window = nullptr;
      }
      disable_window_transitions(window);
      respond(id, window && IsWindow(window) ? true : false);
    } else if (command == "ping") {
      respond(id, true);
    } else if (command == "quit") {
      respond(id, true);
      running = false;
      PostThreadMessageW(message_thread_id, WM_QUIT, 0, 0);
      break;
    } else if (!id.empty()) {
      respond(id, false, "\"error\":\"unknown-command\"");
    }
  }
  if (running.exchange(false)) {
    PostThreadMessageW(message_thread_id, WM_QUIT, 0, 0);
  }
}
}  // namespace

int main() {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  message_thread_id = GetCurrentThreadId();
  mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, GetModuleHandleW(nullptr), 0);
  keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_proc, GetModuleHandleW(nullptr), 0);
  if (!mouse_hook || !keyboard_hook) {
    emit("{\"type\":\"fatal\",\"error\":\"input-hook-install-failed\"}");
    if (mouse_hook) UnhookWindowsHookEx(mouse_hook);
    if (keyboard_hook) UnhookWindowsHookEx(keyboard_hook);
    return 2;
  }

  emit("{\"type\":\"ready\"}");
  std::thread reader(command_loop);
  MSG message{};
  while (running && GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  running = false;
  UnhookWindowsHookEx(mouse_hook);
  UnhookWindowsHookEx(keyboard_hook);
  if (reader.joinable()) reader.join();
  return 0;
}

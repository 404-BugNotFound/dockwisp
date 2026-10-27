#include <windows.h>
#include <UIAutomation.h>
#include <dwmapi.h>

#include <atomic>
#include <cstdint>
#include <cwctype>
#include <fstream>
#include <iostream>
#include <iterator>
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

// Remote-desktop clients: when one of these owns the foreground window the user
// is typing into the remote machine, so Alt+Space must reach the client (and the
// remote launcher) instead of summoning the local one.
constexpr const wchar_t* kRemoteDesktopProcesses[] = {
    L"mstsc.exe",          L"msrdc.exe",        L"vmconnect.exe",
    L"gameviewer.exe",     L"uuremote.exe",     L"todesk.exe",
    L"todesk_session.exe", L"sunloginclient.exe", L"sunloginremote.exe",
    L"awesun.exe",         L"anydesk.exe",      L"teamviewer.exe",
    L"rustdesk.exe",       L"parsecd.exe",      L"vncviewer.exe",
    L"tvnviewer.exe",
};

bool foreground_is_remote_desktop() {
  const HWND window = GetForegroundWindow();
  if (!window) return false;
  DWORD process_id = 0;
  GetWindowThreadProcessId(window, &process_id);
  if (!process_id) return false;
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) return false;
  wchar_t path_buffer[MAX_PATH * 4]{};
  DWORD path_length = static_cast<DWORD>(std::size(path_buffer));
  const bool ok = QueryFullProcessImageNameW(process, 0, path_buffer, &path_length) != FALSE;
  CloseHandle(process);
  if (!ok) return false;
  std::wstring name(path_buffer, path_length);
  const size_t slash = name.find_last_of(L"\\/");
  if (slash != std::wstring::npos) name = name.substr(slash + 1);
  for (auto& character : name) character = static_cast<wchar_t>(towlower(character));
  for (const auto* candidate : kRemoteDesktopProcesses) {
    if (name == candidate) return true;
  }
  return false;
}

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

std::atomic<uint32_t> capture_counter{0};

// Build a unique temp-file path for a screenshot. Returns the wide path, and
// sets `utf8` to its UTF-8 form for the JSON response.
std::wstring make_capture_path(std::string& utf8) {
  wchar_t temp_dir[MAX_PATH]{};
  const DWORD length = GetTempPathW(MAX_PATH, temp_dir);
  std::wstring directory = (length > 0 && length < MAX_PATH) ? std::wstring(temp_dir, length)
                                                             : std::wstring(L".\\");
  wchar_t name[128]{};
  swprintf(name, static_cast<int>(std::size(name)), L"dockwisp-shot-%lu-%llu-%u.bmp",
           GetCurrentProcessId(), static_cast<unsigned long long>(GetTickCount64()),
           capture_counter.fetch_add(1));
  std::wstring full = directory + name;
  utf8 = to_utf8(full);
  return full;
}

// Capture a rectangle of the virtual screen (physical pixels) with BitBlt and
// write it as an uncompressed 32-bit BMP. `x`/`y` are in the same physical
// coordinate space Electron's screen.dipToScreenRect produces. Returns true on
// success and fills `out_path` (UTF-8). CAPTURECLT includes layered windows.
bool capture_screen_rect(long x, long y, long width, long height, std::string& out_path,
                         std::string& error) {
  if (width <= 0 || height <= 0) {
    error = "invalid-capture-size";
    return false;
  }
  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) {
    error = "no-screen-dc";
    return false;
  }
  HDC memory_dc = CreateCompatibleDC(screen_dc);
  HBITMAP bitmap = memory_dc ? CreateCompatibleBitmap(screen_dc, width, height) : nullptr;
  bool ok = false;
  if (memory_dc && bitmap) {
    HGDIOBJ previous = SelectObject(memory_dc, bitmap);
    if (BitBlt(memory_dc, 0, 0, width, height, screen_dc, x, y, SRCCOPY | CAPTUREBLT)) {
      BITMAPINFO info{};
      info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      info.bmiHeader.biWidth = width;
      // Positive height => bottom-up BMP, the conventional layout decoders expect.
      info.bmiHeader.biHeight = height;
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      info.bmiHeader.biCompression = BI_RGB;
      const size_t row_bytes = static_cast<size_t>(width) * 4;
      const size_t pixel_bytes = row_bytes * static_cast<size_t>(height);
      std::vector<uint8_t> pixels(pixel_bytes);
      if (GetDIBits(memory_dc, bitmap, 0, static_cast<UINT>(height), pixels.data(), &info,
                    DIB_RGB_COLORS)) {
        // GDI leaves the 4th byte (alpha) at 0; force opaque so decoders that
        // honour the alpha channel do not render a fully transparent image.
        for (size_t i = 3; i < pixel_bytes; i += 4) pixels[i] = 0xFF;

        BITMAPFILEHEADER file_header{};
        file_header.bfType = 0x4D42;  // "BM"
        file_header.bfOffBits =
            sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
        file_header.bfSize =
            file_header.bfOffBits + static_cast<DWORD>(pixel_bytes);

        BITMAPINFOHEADER out_header = info.bmiHeader;
        out_header.biSizeImage = static_cast<DWORD>(pixel_bytes);

        std::wstring path = make_capture_path(out_path);
        std::ofstream file(path.c_str(), std::ios::binary | std::ios::trunc);
        if (file) {
          file.write(reinterpret_cast<const char*>(&file_header), sizeof(file_header));
          file.write(reinterpret_cast<const char*>(&out_header), sizeof(out_header));
          file.write(reinterpret_cast<const char*>(pixels.data()),
                     static_cast<std::streamsize>(pixel_bytes));
          ok = file.good();
          if (!ok) error = "write-failed";
        } else {
          error = "open-failed";
        }
      } else {
        error = "getdibits-failed";
      }
    } else {
      error = "bitblt-failed";
    }
    SelectObject(memory_dc, previous);
  } else {
    error = "gdi-alloc-failed";
  }
  if (bitmap) DeleteObject(bitmap);
  if (memory_dc) DeleteDC(memory_dc);
  ReleaseDC(nullptr, screen_dc);
  return ok;
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
  } else if (code == HC_ACTION && (event == WM_LBUTTONDOWN || event == WM_RBUTTONDOWN)) {
    // Lets the translation popup close when the user clicks anywhere outside it,
    // even though the popup is shown without taking focus.
    const auto* info = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    std::ostringstream stream;
    stream << "{\"type\":\"click\",\"x\":" << info->pt.x << ",\"y\":" << info->pt.y << "}";
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
      // Let a focused remote-desktop client forward the chord to the remote PC.
      if (!launcher_space_suppressed && foreground_is_remote_desktop()) {
        return CallNextHookEx(keyboard_hook, code, event, data);
      }
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
    } else if (command == "capture") {
      // capture <id> <x> <y> <width> <height> — physical-pixel rect.
      long y = 0;
      long width = 0;
      long height = 0;
      input >> y >> width >> height;
      long x = 0;
      bool parsed = true;
      try {
        x = std::stol(value);
      } catch (...) {
        parsed = false;
      }
      if (!parsed) {
        respond(id, false, "\"error\":\"invalid-capture-args\"");
      } else {
        std::string path;
        std::string error;
        if (capture_screen_rect(x, y, width, height, path, error)) {
          std::ostringstream fields;
          fields << "\"path\":\"" << json_escape(path) << "\",\"width\":" << width
                 << ",\"height\":" << height;
          respond(id, true, fields.str());
        } else {
          respond(id, false, "\"error\":\"" + json_escape(error) + "\"");
        }
      }
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

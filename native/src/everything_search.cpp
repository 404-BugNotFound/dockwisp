#include <windows.h>
#include <shellapi.h>

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "../sdk/Everything.h"

namespace {
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
}  // namespace

int main() {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);

  int argument_count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (!arguments || argument_count < 2) {
    std::cout << "{\"ok\":false,\"error\":\"missing-query\"}" << std::endl;
    if (arguments) LocalFree(arguments);
    return 2;
  }
  const std::wstring first = arguments[1];

  // --status: report whether the Everything IPC window and database are ready.
  // Do not run a query in this mode.
  if (first == L"--status") {
    LocalFree(arguments);
    const bool db_loaded = Everything_IsDBLoaded() == TRUE;
    const DWORD error = Everything_GetLastError();
    const bool ipc = error != EVERYTHING_ERROR_IPC;
    std::cout << "{\"ok\":true,\"ipc\":" << (ipc ? "true" : "false")
              << ",\"dbLoaded\":" << (db_loaded ? "true" : "false")
              << ",\"error\":" << error << "}" << std::endl;
    return 0;
  }

  const std::wstring query = first;
  LocalFree(arguments);
  if (query.empty()) {
    std::cout << "{\"ok\":true,\"results\":[]}" << std::endl;
    return 0;
  }

  // The database must be loaded before querying; otherwise Everything is still
  // building its index (the first index can take minutes).
  if (Everything_IsDBLoaded() != TRUE) {
    const DWORD error = Everything_GetLastError();
    if (error == EVERYTHING_ERROR_IPC) {
      std::cout << "{\"ok\":false,\"ipc\":false,\"error\":" << error << "}" << std::endl;
      return 4;
    }
    std::cout << "{\"ok\":false,\"indexing\":true,\"error\":" << error << "}" << std::endl;
    return 4;
  }

  Everything_SetSearchW(query.c_str());
  Everything_SetMatchPath(FALSE);
  Everything_SetMatchCase(FALSE);
  Everything_SetMatchWholeWord(FALSE);
  Everything_SetRegex(FALSE);
  Everything_SetMax(500);
  Everything_SetRequestFlags(EVERYTHING_REQUEST_FILE_NAME | EVERYTHING_REQUEST_PATH |
                             EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME);
  Everything_SetSort(EVERYTHING_SORT_NAME_ASCENDING);

  if (!Everything_QueryW(TRUE)) {
    const DWORD error = Everything_GetLastError();
    if (error == EVERYTHING_ERROR_IPC) {
      std::cout << "{\"ok\":false,\"ipc\":false,\"error\":" << error << "}" << std::endl;
    } else {
      std::cout << "{\"ok\":false,\"error\":\"query-failed\",\"code\":" << error << "}"
                << std::endl;
    }
    Everything_CleanUp();
    return 3;
  }

  const DWORD count = Everything_GetNumResults();
  std::vector<wchar_t> buffer(32768);
  std::ostringstream output;
  output << "{\"ok\":true,\"results\":[";
  bool first_result = true;
  for (DWORD index = 0; index < count; ++index) {
    if (!Everything_IsFileResult(index)) continue;
    buffer[0] = L'\0';
    if (Everything_GetResultFullPathNameW(index, buffer.data(),
                                          static_cast<DWORD>(buffer.size())) == 0) {
      continue;
    }
    const std::string path = to_utf8(buffer.data());
    if (path.empty()) continue;
    if (!first_result) output << ',';
    first_result = false;
    output << "{\"path\":\"" << json_escape(path) << "\"}";
  }
  output << "]}";
  std::cout << output.str() << std::endl;

  Everything_CleanUp();
  return 0;
}

// Adapted from seihn2/penumbra at 1b023aad26fc601045fc7948fe16666272d37661.
// CC BY-NC 4.0; see NOTICE.md and licenses/Penumbra-LICENSE.txt.
// Audio-only WASAPI render loopback. No screen, microphone, network or files.
// https://learn.microsoft.com/windows/win32/coreaudio/loopback-recording
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include "AudioFrame.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
struct Failure { const char* code; };

void check(HRESULT result) {
    if (SUCCEEDED(result)) return;
    if (result == E_ACCESSDENIED) throw Failure{"permission-denied"};
    if (result == AUDCLNT_E_UNSUPPORTED_FORMAT) throw Failure{"format-unsupported"};
    throw Failure{"device-unavailable"};
}

void status(const std::string& value) {
    const std::string line = value + "\n";
    DWORD written = 0;
    if (!WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(),
                   static_cast<DWORD>(line.size()), &written, nullptr) ||
        written != static_cast<DWORD>(line.size()))
        throw Failure{"transport-error"};
}

void stage(const char* value) {
    status(std::string("{\"type\":\"stage\",\"stage\":\"") + value + "\"}");
}

void ready() {
    status("{\"type\":\"ready\",\"protocol\":1,\"sampleRate\":16000,\"channels\":1,\"format\":\"pcm_s16le\"}");
}

// Independent lifetime guard works even if device activation or pipe writes
// stall. stdin EOF is the graceful-stop channel; the parent handle prevents
// orphan capture after an application crash. Never inherit provider credentials.
class Lifetime {
    HANDLE parent_;
    HANDLE done_ = nullptr;
    HANDLE mainThread_ = nullptr;
    std::thread watcher_;
public:
    std::atomic<bool> stopped{false};
    std::atomic<bool> backpressured{false};
    std::atomic<ULONGLONG> writingAt{0};
    explicit Lifetime(HANDLE parent) : parent_(parent) {
        done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!done_ || !DuplicateHandle(GetCurrentProcess(), GetCurrentThread(),
                GetCurrentProcess(), &mainThread_, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            if (done_) CloseHandle(done_);
            throw Failure{"transport-error"};
        }
        watcher_ = std::thread([this] {
            while (WaitForSingleObject(done_, 20) == WAIT_TIMEOUT) {
                DWORD available = 0;
                const bool inputClosed = !PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),
                    nullptr, 0, nullptr, &available, nullptr);
                const auto writing = writingAt.load();
                const bool blocked = writing && GetTickCount64() - writing > 2000;
                if (WaitForSingleObject(parent_, 0) != WAIT_TIMEOUT || inputClosed || blocked) {
                    backpressured = blocked;
                    stopped = true;
                    CancelSynchronousIo(mainThread_);
                    // COM drivers need not respect cancellation. Bound retirement.
                    if (WaitForSingleObject(done_, 1500) != WAIT_OBJECT_0)
                        TerminateProcess(GetCurrentProcess(), blocked ? 1U : 0U);
                    return;
                }
            }
        });
    }
    ~Lifetime() {
        SetEvent(done_);
        if (watcher_.joinable()) watcher_.join();
        CloseHandle(mainThread_);
        CloseHandle(done_);
    }
    Lifetime(const Lifetime&) = delete;
    Lifetime& operator=(const Lifetime&) = delete;
};

void writeBytes(Lifetime& lifetime, const std::uint8_t* bytes, DWORD length) {
    lifetime.writingAt = GetTickCount64();
    DWORD offset = 0;
    while (offset < length && !lifetime.stopped) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes + offset, length - offset,
                       &written, nullptr) || written == 0) {
            lifetime.writingAt = 0;
            throw Failure{"transport-error"};
        }
        offset += written;
    }
    lifetime.writingAt = 0;
}

void writePcm(Lifetime& lifetime, const std::vector<std::uint8_t>& bytes) {
    for (std::size_t offset = 0; offset < bytes.size() && !lifetime.stopped;) {
        const auto length = static_cast<std::uint32_t>(
            std::min<std::size_t>(lingobar::kAudioFrameLimit, bytes.size() - offset));
        const auto header = lingobar::audioFrameHeader(length);
        writeBytes(lifetime, header.data(), static_cast<DWORD>(header.size()));
        writeBytes(lifetime, bytes.data() + offset, length);
        offset += length;
    }
}

struct ComApartment {
    ComApartment() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
    ~ComApartment() { CoUninitialize(); }
};

std::wstring deviceId(IMMDevice* device) {
    LPWSTR raw = nullptr;
    check(device->GetId(&raw));
    const std::wstring value(raw);
    CoTaskMemFree(raw);
    return value;
}

void capture(Lifetime& lifetime) {
    stage("initializing");
    ComApartment apartment;
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                           IID_PPV_ARGS(enumerator.GetAddressOf())));
    stage("reading-output");
    ComPtr<IMMDevice> device;
    check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.GetAddressOf()));
    const auto originalDevice = deviceId(device.Get());
    stage("creating-tap");
    ComPtr<IAudioClient> client;
    check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                           reinterpret_cast<void**>(client.GetAddressOf())));
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 1;
    format.nSamplesPerSec = 16000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 2;
    format.nAvgBytesPerSec = 32000;
    stage("creating-device");
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        1000000, 0, &format, nullptr));
    ComPtr<IAudioCaptureClient> reader;
    check(client->GetService(IID_PPV_ARGS(reader.GetAddressOf())));
    stage("starting-device");
    if (lifetime.stopped) return;
    check(client->Start());
    // Release/Stop runs on every exit, including device loss or backpressure.
    struct StopStream {
        IAudioClient* client;
        ~StopStream() { client->Stop(); }
    } stop{client.Get()};
    ready();
    auto checkedDeviceAt = GetTickCount64();
    while (!lifetime.stopped) {
        if (GetTickCount64() - checkedDeviceAt >= 1000) {
            ComPtr<IMMDevice> current;
            check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, current.GetAddressOf()));
            if (deviceId(current.Get()) != originalDevice) throw Failure{"device-unavailable"};
            checkedDeviceAt = GetTickCount64();
        }
        UINT32 frames = 0;
        check(reader->GetNextPacketSize(&frames));
        if (!frames) { Sleep(10); continue; }
        BYTE* data = nullptr;
        DWORD flags = 0;
        check(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
        // Release the OS packet before any potentially blocking pipe operation.
        std::vector<std::uint8_t> pcm;
        try {
            if (frames > 32000) throw Failure{"buffer-overflow"};
            pcm.resize(static_cast<std::size_t>(frames) * 2, 0);
            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && !pcm.empty()) {
                if (!data) throw Failure{"protocol-error"};
                std::memcpy(pcm.data(), data, pcm.size());
            }
        } catch (...) {
            reader->ReleaseBuffer(frames);
            throw;
        }
        check(reader->ReleaseBuffer(frames));
        writePcm(lifetime, pcm);
    }
}

// Opt-in offline stream for CI: never creates a COM audio object or device.
void syntheticStream(Lifetime& lifetime) {
    ready();
    const std::vector<std::uint8_t> pcm(lingobar::kAudioFrameLimit, 0);
    while (!lifetime.stopped) writePcm(lifetime, pcm);
}

int selfTest() {
    const auto small = lingobar::audioFrameHeader(2);
    const auto large = lingobar::audioFrameHeader(8192);
    if (small != std::array<std::uint8_t, 8>{'P', 'C', 'M', '1', 2, 0, 0, 0} ||
        large[4] != 0 || large[5] != 32) return 1;
    for (const auto invalid : {0U, 1U, 3U, 8193U, 0xffffffffU}) {
        try { lingobar::audioFrameHeader(invalid); return 1; }
        catch (const std::invalid_argument&) { }
    }
    // Cover every legal PCM frame size, not just the two boundary examples.
    for (std::uint32_t size = 2; size <= lingobar::kAudioFrameLimit; size += 2) {
        const auto header = lingobar::audioFrameHeader(size);
        const auto decoded = static_cast<std::uint32_t>(header[4]) |
            (static_cast<std::uint32_t>(header[5]) << 8) |
            (static_cast<std::uint32_t>(header[6]) << 16) |
            (static_cast<std::uint32_t>(header[7]) << 24);
        if (decoded != size) return 1;
    }
    // Only HRESULT classification: no COM object, permission prompt or device.
    check(S_OK);
    const auto classified = [](HRESULT result, const char* expected) {
        try { check(result); return false; }
        catch (const Failure& error) { return std::strcmp(error.code, expected) == 0; }
    };
    if (!classified(E_ACCESSDENIED, "permission-denied") ||
        !classified(AUDCLNT_E_UNSUPPORTED_FORMAT, "format-unsupported") ||
        !classified(AUDCLNT_E_DEVICE_INVALIDATED, "device-unavailable") ||
        !classified(HRESULT_FROM_WIN32(ERROR_NOT_FOUND), "device-unavailable")) return 1;
    const char output[] = "SELF_TEST_OK\n";
    DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), output, static_cast<DWORD>(sizeof(output) - 1),
                     &written, nullptr) ? 0 : 1;
}
} // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::strcmp(argv[1], "--self-test") == 0) return selfTest();
    if (argc != 4 || (std::strcmp(argv[1], "--capture") != 0 &&
                     std::strcmp(argv[1], "--self-test-stream") != 0) ||
        std::strcmp(argv[2], "--parent-pid") != 0) return 2;
    const std::string pidText(argv[3]);
    if (pidText.empty() || pidText.size() > 10 ||
        !std::all_of(pidText.begin(), pidText.end(), [](char c) { return c >= '0' && c <= '9'; })) return 2;
    const auto pid = std::strtoull(argv[3], nullptr, 10);
    if (!pid || pid > std::numeric_limits<DWORD>::max()) return 2;
    const HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
    if (!parent) return 2;
    int result = 0;
    try {
        Lifetime lifetime(parent);
        try {
            if (std::strcmp(argv[1], "--self-test-stream") == 0) syntheticStream(lifetime);
            else capture(lifetime);
        } catch (const Failure& error) {
            if (!lifetime.stopped) {
                status(std::string("{\"type\":\"error\",\"code\":\"") + error.code + "\"}");
                result = 1;
            }
        }
        if (lifetime.backpressured) {
            status("{\"type\":\"error\",\"code\":\"buffer-overflow\"}");
            result = 1;
        }
    } catch (...) { result = 1; }
    CloseHandle(parent);
    return result;
}

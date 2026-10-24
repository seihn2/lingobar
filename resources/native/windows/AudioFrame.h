// Adapted from seihn2/penumbra at 1b023aad26fc601045fc7948fe16666272d37661.
// CC BY-NC 4.0; see NOTICE.md and licenses/Penumbra-LICENSE.txt.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace lingobar {
constexpr std::uint32_t kAudioFrameLimit = 8192;

// Same PCM1 framing as the macOS helper: LE byte length, 16kHz mono PCM16.
inline std::array<std::uint8_t, 8> audioFrameHeader(std::uint32_t bytes) {
    if (bytes < 2 || bytes > kAudioFrameLimit || bytes % 2 != 0)
        throw std::invalid_argument("invalid audio frame length");
    return {'P', 'C', 'M', '1', static_cast<std::uint8_t>(bytes),
            static_cast<std::uint8_t>(bytes >> 8), static_cast<std::uint8_t>(bytes >> 16),
            static_cast<std::uint8_t>(bytes >> 24)};
}
} // namespace lingobar

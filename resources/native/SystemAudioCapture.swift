// Audio-only Core Audio process tap. No screen, video, microphone, or AppKit API.
// --self-test is dispatched before constructing any HAL capture object.
import Foundation
import CoreAudio
import AVFAudio
import Dispatch
import Darwin

private enum CaptureFailure: Int32, Error {
    case unsupported = 1, permissionDenied, deviceUnavailable, formatUnsupported
    case transportError, bufferOverflow, invalidRequest

    var code: String {
        switch self {
        case .unsupported: return "unsupported"
        case .permissionDenied: return "permission-denied"
        case .deviceUnavailable: return "device-unavailable"
        case .formatUnsupported: return "format-unsupported"
        case .transportError: return "transport-error"
        case .bufferOverflow: return "buffer-overflow"
        case .invalidRequest: return "invalid-request"
        }
    }
}

// OSAtomic remains available on the macOS 13 deployment target. Allocated
// words avoid Swift inout exclusivity access spanning concurrent callbacks.
private final class AtomicWord {
    let pointer: UnsafeMutablePointer<Int32>
    init(_ value: Int32 = 0) {
        pointer = .allocate(capacity: 1)
        pointer.initialize(to: value)
    }
    deinit { pointer.deinitialize(count: 1); pointer.deallocate() }
    @inline(__always) func load() -> Int32 { OSAtomicAdd32Barrier(0, pointer) }
    @inline(__always) func replace(_ old: Int32, _ new: Int32) -> Bool {
        OSAtomicCompareAndSwap32Barrier(old, new, pointer)
    }
    @inline(__always) func add(_ value: Int32) { _ = OSAtomicAdd32Barrier(value, pointer) }
}

private final class StopState {
    let stopped = AtomicWord()
    let failure = AtomicWord()
    @inline(__always) var isStopped: Bool { stopped.load() != 0 }
    @inline(__always) func stop() { _ = stopped.replace(0, 1) }
    @inline(__always) func fail(_ error: CaptureFailure) {
        _ = failure.replace(0, error.rawValue)
        stop()
    }
    var error: CaptureFailure? { CaptureFailure(rawValue: failure.load()) }
}

private struct PCMLayout {
    let format: AVAudioFormat
    let rate: Double
    let channels: Int
    let buffers: Int
    let bytesPerFramePerBuffer: Int
    let maximumFrames: Int

    init(_ asbd: AudioStreamBasicDescription) throws {
        var description = asbd
        let channels = Int(asbd.mChannelsPerFrame)
        let planar = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let buffers = planar ? channels : 1
        let bytesPerFrame = Int(asbd.mBytesPerFrame)
        guard asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mSampleRate.isFinite, (8000...384000).contains(asbd.mSampleRate),
              (1...8).contains(channels), bytesPerFrame > 0,
              bytesPerFrame <= 64, asbd.mFramesPerPacket == 1,
              let format = AVAudioFormat(streamDescription: &description) else {
            throw CaptureFailure.formatUnsupported
        }
        self.format = format
        rate = asbd.mSampleRate
        self.channels = channels
        self.buffers = buffers
        bytesPerFramePerBuffer = bytesPerFrame
        maximumFrames = min(16384, AudioRing.slotBytes / (bytesPerFrame * buffers))
    }
}

/// SPSC ring: producer is the one IOProc, consumer is the conversion worker.
/// Slot storage and metadata are allocated before AudioDeviceStart. The callback
/// only reads metadata, copies bytes and uses full-barrier atomics: no lock wait,
/// Dispatch async, resampling, logging, JSON, pipe write, or collection mutation.
private final class AudioRing {
    static let slotBytes = 65536
    let capacity: Int
    let storage: UnsafeMutableRawPointer
    let frameCounts: UnsafeMutablePointer<Int32>
    let head = AtomicWord()
    let tail = AtomicWord()
    let queuedFrames = AtomicWord()
    let layout: PCMLayout
    let stop: StopState

    init(layout: PCMLayout, stop: StopState, capacity: Int = 256) {
        self.layout = layout
        self.stop = stop
        self.capacity = max(2, capacity)
        storage = .allocate(byteCount: self.capacity * Self.slotBytes, alignment: 64)
        storage.initializeMemory(as: UInt8.self, repeating: 0, count: self.capacity * Self.slotBytes)
        frameCounts = .allocate(capacity: self.capacity)
        frameCounts.initialize(repeating: 0, count: self.capacity)
    }
    deinit { storage.deallocate(); frameCounts.deinitialize(count: capacity); frameCounts.deallocate() }

    @inline(__always) func push(_ list: UnsafePointer<AudioBufferList>) {
        if stop.isStopped { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        if buffers.count != layout.buffers { stop.fail(.formatUnsupported); return }
        let firstBytes = Int(buffers[0].mDataByteSize)
        let frames = firstBytes / layout.bytesPerFramePerBuffer
        if firstBytes == 0 { return }
        if frames < 1 || frames > layout.maximumFrames ||
            firstBytes % layout.bytesPerFramePerBuffer != 0 {
            stop.fail(.formatUnsupported); return
        }
        let currentHead = head.load()
        let nextHead = (currentHead + 1) % Int32(capacity)
        if nextHead == tail.load() || Int(queuedFrames.load()) + frames > Int(layout.rate * 2) {
            stop.fail(.bufferOverflow); return
        }
        let destination = storage.advanced(by: Int(currentHead) * Self.slotBytes)
        for index in 0..<buffers.count {
            let buffer = buffers[index]
            let expectedChannels = layout.buffers == 1 ? layout.channels : 1
            if Int(buffer.mDataByteSize) != firstBytes || Int(buffer.mNumberChannels) != expectedChannels {
                stop.fail(.formatUnsupported); return
            }
            guard let source = buffer.mData else { stop.fail(.formatUnsupported); return }
            memcpy(destination.advanced(by: index * firstBytes), source, firstBytes)
        }
        frameCounts[Int(currentHead)] = Int32(frames)
        queuedFrames.add(Int32(frames))
        _ = head.replace(currentHead, nextHead)
    }

    /// Only the worker calls this, and copies before releasing the producer slot.
    func pop(into buffer: AVAudioPCMBuffer) -> Bool {
        let currentTail = tail.load()
        if currentTail == head.load() { return false }
        let frames = Int(frameCounts[Int(currentTail)])
        buffer.frameLength = AVAudioFrameCount(frames)
        let bytes = frames * layout.bytesPerFramePerBuffer
        let destination = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let source = storage.advanced(by: Int(currentTail) * Self.slotBytes)
        for index in 0..<layout.buffers {
            memcpy(destination[index].mData!, source.advanced(by: index * bytes), bytes)
        }
        queuedFrames.add(-Int32(frames))
        _ = tail.replace(currentTail, (currentTail + 1) % Int32(capacity))
        return true
    }
}

// Match Apple's C IOProc registration path. The capture owns the ring until
// AudioDeviceStop + AudioDeviceDestroyIOProcID complete; this callback neither
// retains/releases it nor dispatches work onto another queue.
private let captureIOProc: AudioDeviceIOProc = { _, _, input, _, _, _, context in
    guard let context else { return kAudioHardwareBadObjectError }
    Unmanaged<AudioRing>.fromOpaque(context).takeUnretainedValue().push(input)
    return noErr
}

private func deviceChangeListener(_ stop: StopState) -> AudioObjectPropertyListenerBlock {
    { _, _ in stop.fail(.deviceUnavailable) }
}

private func framePacket(_ payload: UnsafeRawBufferPointer) throws -> Data {
    guard payload.count > 0, payload.count <= 8192, payload.count % 2 == 0 else {
        throw CaptureFailure.formatUnsupported
    }
    var packet = Data([0x50, 0x43, 0x4d, 0x31])
    var length = UInt32(payload.count).littleEndian
    withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
    packet.append(contentsOf: payload)
    return packet
}

private final class PCMConverter {
    let input: AVAudioPCMBuffer
    let output: AVAudioPCMBuffer
    let converter: AVAudioConverter

    init(_ layout: PCMLayout) throws {
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000,
                                        channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: layout.format, to: target),
              let input = AVAudioPCMBuffer(pcmFormat: layout.format, frameCapacity: AVAudioFrameCount(layout.maximumFrames)),
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) else {
            throw CaptureFailure.formatUnsupported
        }
        self.converter = converter
        self.input = input
        self.output = output
    }

    /// Never recreate the converter between input chunks: its fractional phase
    /// and filter history must survive callback boundaries, including 44.1 kHz.
    func convert(endOfStream: Bool = false, consume: (UnsafeRawBufferPointer) throws -> Void) throws {
        var supplied = false
        for _ in 0..<64 {
            output.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if endOfStream { inputStatus.pointee = .endOfStream; return nil }
                if supplied { inputStatus.pointee = .noDataNow; return nil }
                supplied = true
                inputStatus.pointee = .haveData
                return self.input
            }
            if status == .error || error != nil { throw CaptureFailure.formatUnsupported }
            let frames = Int(output.frameLength)
            if frames > 0, let samples = output.int16ChannelData?[0] {
                try consume(UnsafeRawBufferPointer(start: samples, count: frames * 2))
            }
            if status == .inputRanDry || status == .endOfStream { return }
            if frames == 0 { return }
        }
        throw CaptureFailure.formatUnsupported
    }
}

/// Called on the conversion worker, never on the synchronous Core Audio IOProc.
/// Every wait is short and checks cancellation; stderr has no blocking fallback.
private func writePacket(_ packet: Data, fd: Int32, stop: StopState, timeoutMs: UInt64 = 500) throws {
    let deadline = DispatchTime.now().uptimeNanoseconds + timeoutMs * 1_000_000
    try packet.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            if stop.isStopped { return }
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count > 0 { offset += count; continue }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                if DispatchTime.now().uptimeNanoseconds >= deadline { throw CaptureFailure.transportError }
                var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = Darwin.poll(&descriptor, 1, 20)
                continue
            }
            throw CaptureFailure.transportError
        }
    }
}

private func nonblocking(_ fd: Int32) throws {
    let flags = fcntl(fd, F_GETFL)
    guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0 else {
        throw CaptureFailure.transportError
    }
}

private func emitStatus(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    data.append(0x0a)
    data.withUnsafeBytes { bytes in _ = Darwin.write(STDERR_FILENO, bytes.baseAddress!, bytes.count) }
}

@available(macOS 14.2, *)
private final class SystemAudioCapture {
    private let stop = StopState()
    private let control = DispatchQueue(label: "com.lingobar.system-audio.control")
    // HAL startup may block control. Device invalidation must still reach the
    // atomic stop flag so the independent liveness watchdog can retire it.
    private let deviceEvents = DispatchQueue(label: "com.lingobar.system-audio.device-events")
    private let liveness = DispatchQueue(label: "com.lingobar.system-audio.liveness")
    private let worker = DispatchQueue(label: "com.lingobar.system-audio.converter", qos: .userInitiated)
    private var sources: [DispatchSourceProtocol] = []
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var ring: AudioRing?
    private var converter: PCMConverter?
    private var finished = false
    private let parentPID: pid_t

    init(parentPID: pid_t) { self.parentPID = parentPID }

    func run() {
        // Fixed, one-shot phases only: no device names, identifiers, or audio.
        // The parent measures delivery time without extending its startup limit.
        emitStatus(["type": "stage", "stage": "initializing"])
        installLiveness()
        control.async { [self] in
            do {
                if stop.isStopped { shutdown(); return }
                try prepare()
                if stop.isStopped { shutdown(); return }
                guard let ioProc else { throw CaptureFailure.deviceUnavailable }
                emitStatus(["type": "stage", "stage": "starting-device"])
                try checkHAL(AudioDeviceStart(aggregateID, ioProc))
                if stop.isStopped { shutdown(); return }
                emitStatus(["type": "ready", "protocol": 1, "sampleRate": 16000,
                            "channels": 1, "format": "pcm_s16le"])
                worker.async { [self] in processAudio() }
            } catch {
                stop.fail(error as? CaptureFailure ?? .deviceUnavailable)
                shutdown()
            }
        }
    }

    private func checkHAL(_ status: OSStatus) throws {
        if status == noErr { return }
        throw status == kAudioDevicePermissionsError ? CaptureFailure.permissionDenied : .deviceUnavailable
    }

    private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                   mElement: kAudioObjectPropertyElementMain)
    }

    private func defaultOutput() throws -> AudioObjectID {
        var property = address(kAudioHardwarePropertyDefaultOutputDevice)
        var value = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try checkHAL(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &value))
        guard value != kAudioObjectUnknown else { throw CaptureFailure.deviceUnavailable }
        return value
    }

    private func exclusions() -> [AudioObjectID] {
        var excluded = Set<AudioObjectID>()
        for var pid in [getpid(), parentPID] {
            var property = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
            var object = AudioObjectID(kAudioObjectUnknown)
            var size = UInt32(MemoryLayout<AudioObjectID>.size)
            let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property,
                UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
            if status == noErr && object != kAudioObjectUnknown { excluded.insert(object) }
        }
        var property = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size) == noErr,
              size > 0, size <= 4096 * MemoryLayout<AudioObjectID>.size else { return Array(excluded) }
        var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        let result = processes.withUnsafeMutableBytes {
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, $0.baseAddress!)
        }
        if result == noErr {
            for process in processes {
                var bundleProperty = address(kAudioProcessPropertyBundleID)
                var bundle: Unmanaged<CFString>?
                var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
                if AudioObjectGetPropertyData(process, &bundleProperty, 0, nil, &bundleSize, &bundle) == noErr,
                   let bundleID = bundle?.takeRetainedValue() as String?,
                   bundleID == "com.lingobar.app" || bundleID.hasPrefix("com.lingobar.app.") {
                    excluded.insert(process)
                }
            }
        }
        return Array(excluded)
    }

    private func listen(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws {
        var property = address(selector)
        // The listener only invalidates; it never calls HAL or synchronously
        // waits on control. A fresh start remains an explicit user action.
        let listener = deviceChangeListener(stop)
        try checkHAL(AudioObjectAddPropertyListenerBlock(object, &property, deviceEvents, listener))
        listeners.append((object, property, listener))
    }

    private func prepare() throws {
        emitStatus(["type": "stage", "stage": "reading-output"])
        let outputDevice = try defaultOutput()
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: exclusions())
        description.name = "LingoBar System Audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        emitStatus(["type": "stage", "stage": "creating-tap"])
        try checkHAL(AudioHardwareCreateProcessTap(description, &tapID))
        guard tapID != kAudioObjectUnknown else { throw CaptureFailure.deviceUnavailable }
        var formatProperty = address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try checkHAL(AudioObjectGetPropertyData(tapID, &formatProperty, 0, nil, &formatSize, &asbd))
        let layout = try PCMLayout(asbd)
        let ring = AudioRing(layout: layout, stop: stop)
        self.ring = ring
        converter = try PCMConverter(layout)
        // No physical input/output subdevice is inserted. In particular, a
        // headset's microphone cannot accidentally become aggregate input 0.
        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey: "LingoBar Private Audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true
            ]]
        ]
        emitStatus(["type": "stage", "stage": "creating-device"])
        try checkHAL(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregateID))
        guard aggregateID != kAudioObjectUnknown else { throw CaptureFailure.deviceUnavailable }
        // C IOProc is a compatibility change, not a proven cure for HAL hangs.
        // Do not add physical subdevices or alter the tap-only privacy boundary.
        try checkHAL(AudioDeviceCreateIOProcID(aggregateID, captureIOProc,
            Unmanaged.passUnretained(ring).toOpaque(), &ioProc))
        guard ioProc != nil else { throw CaptureFailure.deviceUnavailable }
        try listen(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice)
        try listen(outputDevice, kAudioDevicePropertyDeviceIsAlive)
        try listen(outputDevice, kAudioDevicePropertyNominalSampleRate)
        try listen(tapID, kAudioTapPropertyFormat)
        // Close the output-change race between reading the default and adding
        // its listener. We never set any default device, volume, or mute value.
        if try defaultOutput() != outputDevice { throw CaptureFailure.deviceUnavailable }
    }

    private func processAudio() {
        guard let ring, let converter else { stop.fail(.formatUnsupported); return }
        do {
            while !stop.isStopped {
                if ring.pop(into: converter.input) {
                    try converter.convert { bytes in
                        try writePacket(framePacket(bytes), fd: STDOUT_FILENO, stop: stop)
                    }
                } else {
                    usleep(2000)
                }
            }
        } catch { stop.fail(error as? CaptureFailure ?? .transportError) }
        control.async { [self] in shutdown() }
    }

    private func installLiveness() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: liveness)
            source.setEventHandler { [self] in stop.stop() }
            source.resume()
            sources.append(source)
        }
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: liveness)
        input.setEventHandler { [self] in
            var bytes = [UInt8](repeating: 0, count: 128)
            let amount = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if amount == 0 || (amount < 0 && errno != EAGAIN && errno != EINTR) { stop.stop() }
        }
        input.resume()
        sources.append(input)
        let parent = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: liveness)
        parent.setEventHandler { [self] in stop.stop() }
        parent.resume()
        sources.append(parent)
        let timer = DispatchSource.makeTimerSource(queue: liveness)
        var shutdownRequestedAt: UInt64?
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler { [self] in
            if getppid() != parentPID || (kill(parentPID, 0) != 0 && errno == ESRCH) { stop.stop() }
            if stop.isStopped {
                let now = DispatchTime.now().uptimeNanoseconds
                if shutdownRequestedAt == nil {
                    shutdownRequestedAt = now
                    control.async { [self] in shutdown() }
                } else if now - shutdownRequestedAt! > 750_000_000 {
                    // HAL calls and a permission prompt must not orphan capture
                    // after the parent disappears. All native objects are private
                    // and ephemeral, so process exit also releases ownership.
                    if let error = stop.error { emitStatus(["type": "error", "code": error.code]) }
                    _exit(stop.error == nil ? 0 : 1)
                }
            }
        }
        timer.resume()
        sources.append(timer)
    }

    private func shutdown() {
        if finished { return }
        finished = true
        stop.stop()
        for (object, savedProperty, listener) in listeners {
            var property = savedProperty
            _ = AudioObjectRemovePropertyListenerBlock(object, &property, deviceEvents, listener)
        }
        listeners.removeAll()
        if let ioProc, aggregateID != kAudioObjectUnknown {
            _ = AudioDeviceStop(aggregateID, ioProc)
            _ = AudioDeviceDestroyIOProcID(aggregateID, ioProc)
        }
        ioProc = nil
        if aggregateID != kAudioObjectUnknown { _ = AudioHardwareDestroyAggregateDevice(aggregateID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if tapID != kAudioObjectUnknown { _ = AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
        if let error = stop.error { emitStatus(["type": "error", "code": error.code]) }
        _exit(stop.error == nil ? 0 : 1)
    }
}

private func syntheticSelfTest() throws {
    var cases: [String] = []
    func callIOProc(_ ring: AudioRing, _ buffer: AVAudioPCMBuffer) -> OSStatus {
        var timestamp = AudioTimeStamp()
        return withUnsafePointer(to: &timestamp) { stamp in
            captureIOProc(0, stamp, buffer.audioBufferList, stamp,
                buffer.mutableAudioBufferList, stamp, Unmanaged.passUnretained(ring).toOpaque())
        }
    }
    for rate in [16000.0, 44100.0, 48000.0] {
        for channels: AVAudioChannelCount in [1, 2] {
            for interleaved in [false, true] {
                let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                          channels: channels, interleaved: interleaved)!
                let layout = try PCMLayout(format.streamDescription.pointee)
                let stop = StopState()
                let ring = AudioRing(layout: layout, stop: stop, capacity: 8)
                let converter = try PCMConverter(layout)
                let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
                var outputBytes = Data()
                var generated = 0
                while generated < Int(rate) {
                    let frames = min(1024, Int(rate) - generated)
                    source.frameLength = AVAudioFrameCount(frames)
                    let buffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
                    for frame in 0..<frames {
                        let sample = Float(sin(Double(generated + frame) * 2 * .pi * 440 / rate) * 0.25)
                        if interleaved {
                            let data = buffers[0].mData!.assumingMemoryBound(to: Float.self)
                            for channel in 0..<Int(channels) { data[frame * Int(channels) + channel] = sample }
                        } else {
                            for channel in 0..<Int(channels) {
                                buffers[channel].mData!.assumingMemoryBound(to: Float.self)[frame] = sample
                            }
                        }
                    }
                    guard callIOProc(ring, source) == noErr else { throw CaptureFailure.deviceUnavailable }
                    guard ring.pop(into: converter.input), !stop.isStopped else { throw CaptureFailure.bufferOverflow }
                    try converter.convert { bytes in outputBytes.append(contentsOf: bytes) }
                    generated += frames
                }
                try converter.convert(endOfStream: true) { bytes in outputBytes.append(contentsOf: bytes) }
                let frameCount = outputBytes.count / 2
                guard abs(frameCount - 16000) <= 64, outputBytes.count % 2 == 0 else { throw CaptureFailure.formatUnsupported }
                let peak = outputBytes.withUnsafeBytes { bytes -> Int in
                    var peak = 0
                    for index in stride(from: 0, to: bytes.count, by: 2) {
                        let value = Int16(bitPattern: UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8))
                        peak = max(peak, abs(Int(value)))
                    }
                    return peak
                }
                guard (5000...10000).contains(peak) else { throw CaptureFailure.formatUnsupported }
                cases.append("resample-\(Int(rate))-\(channels)-\(interleaved ? "interleaved" : "planar")")
            }
        }
    }
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let layout = try PCMLayout(format.streamDescription.pointee)
    let stop = StopState()
    let ring = AudioRing(layout: layout, stop: stop, capacity: 3)
    let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1)!
    source.frameLength = 1
    source.floatChannelData![0][0] = 0
    ring.push(source.audioBufferList); ring.push(source.audioBufferList); ring.push(source.audioBufferList)
    guard stop.error == .bufferOverflow else { throw CaptureFailure.bufferOverflow }
    cases.append("bounded-ring-overflow")
    let payload: [UInt8] = [0, 0, 0xff, 0x7f, 0, 0x80]
    let packet = try payload.withUnsafeBytes { try framePacket($0) }
    guard Array(packet.prefix(8)) == [0x50, 0x43, 0x4d, 0x31, 6, 0, 0, 0], Array(packet.dropFirst(8)) == payload else {
        throw CaptureFailure.transportError
    }
    cases.append("pcm1-little-endian-framing")
    for count in [0, 1, 8193, 8194] {
        let invalid = [UInt8](repeating: 0, count: count)
        var rejected = false
        do { _ = try invalid.withUnsafeBytes { try framePacket($0) } }
        catch CaptureFailure.formatUnsupported { rejected = true }
        guard rejected else { throw CaptureFailure.formatUnsupported }
    }
    cases.append("invalid-frame-length-rejected")

    let fullStop = StopState()
    let durationRing = AudioRing(layout: layout, stop: fullStop, capacity: 8)
    let second = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000)!
    second.frameLength = 16000
    memset(second.floatChannelData![0], 0, 16000 * MemoryLayout<Float>.size)
    durationRing.push(second.audioBufferList)
    durationRing.push(second.audioBufferList)
    guard !fullStop.isStopped else { throw CaptureFailure.bufferOverflow }
    durationRing.push(second.audioBufferList)
    guard fullStop.error == .bufferOverflow else { throw CaptureFailure.bufferOverflow }
    cases.append("two-second-input-budget")

    let cancelled = StopState()
    let cancelledRing = AudioRing(layout: layout, stop: cancelled, capacity: 3)
    cancelled.stop()
    cancelledRing.push(source.audioBufferList)
    guard cancelledRing.head.load() == 0, cancelledRing.queuedFrames.load() == 0 else {
        throw CaptureFailure.bufferOverflow
    }
    cases.append("cancel-prevents-further-enqueue")

    let callbackStop = StopState()
    let callbackRing = AudioRing(layout: layout, stop: callbackStop, capacity: 3)
    let callbackOutput = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1)!
    guard callIOProc(callbackRing, source) == noErr,
          callbackRing.pop(into: callbackOutput), callbackOutput.floatChannelData![0][0] == 0 else {
        throw CaptureFailure.formatUnsupported
    }
    callbackStop.stop()
    guard callIOProc(callbackRing, source) == noErr, !callbackRing.pop(into: callbackOutput) else {
        throw CaptureFailure.bufferOverflow
    }
    cases.append("c-ioproc-context-silence-and-cancellation")

    // Hold a synthetic startup queue while dispatching the actual invalidation
    // callback independently. No HAL object is constructed by this test.
    let blockedControl = DispatchQueue(label: "com.lingobar.synthetic-blocked-start")
    let eventQueue = DispatchQueue(label: "com.lingobar.synthetic-device-events")
    let entered = DispatchSemaphore(value: 0)
    let releaseControl = DispatchSemaphore(value: 0)
    let eventDelivered = DispatchSemaphore(value: 0)
    let deviceStop = StopState()
    let listener = deviceChangeListener(deviceStop)
    blockedControl.async {
        entered.signal()
        releaseControl.wait()
    }
    defer { releaseControl.signal() }
    guard entered.wait(timeout: .now() + .seconds(1)) == .success else { throw CaptureFailure.transportError }
    eventQueue.async {
        var property = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        withUnsafePointer(to: &property) { listener(1, $0) }
        eventDelivered.signal()
    }
    guard eventDelivered.wait(timeout: .now() + .seconds(1)) == .success,
          deviceStop.error == .deviceUnavailable, deviceStop.isStopped else {
        throw CaptureFailure.deviceUnavailable
    }
    cases.append("device-change-invalidates-while-startup-queue-blocked")

    // Exercise the actual shared ring with simultaneous producer/consumer
    // threads and many slot wraps. All samples are generated in memory.
    let concurrentStop = StopState()
    let concurrentRing = AudioRing(layout: layout, stop: concurrentStop, capacity: 8)
    let producerBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32)!
    producerBuffer.frameLength = 32
    let consumerBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32)!
    let producer = DispatchQueue(label: "com.lingobar.synthetic-ring-producer")
    let group = DispatchGroup()
    let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
    let chunkCount = 4096
    group.enter()
    producer.async {
        defer { group.leave() }
        for sequence in 0..<chunkCount {
            // The synthetic producer can wait; the real IOProc never does.
            while (concurrentRing.head.load() + 1) % Int32(concurrentRing.capacity) == concurrentRing.tail.load() {
                if concurrentStop.isStopped { return }
                if DispatchTime.now().uptimeNanoseconds > deadline { concurrentStop.fail(.bufferOverflow); return }
                usleep(25)
            }
            if concurrentStop.isStopped { return }
            let value = Float(sequence) / Float(chunkCount)
            for sample in 0..<32 { producerBuffer.floatChannelData![0][sample] = value }
            concurrentRing.push(producerBuffer.audioBufferList)
        }
    }
    var received = 0
    while received < chunkCount && !concurrentStop.isStopped {
        if DispatchTime.now().uptimeNanoseconds > deadline { concurrentStop.fail(.bufferOverflow); break }
        if concurrentRing.pop(into: consumerBuffer) {
            let expected = Float(received) / Float(chunkCount)
            if consumerBuffer.frameLength != 32 { concurrentStop.fail(.formatUnsupported); break }
            for sample in 0..<32 {
                if consumerBuffer.floatChannelData![0][sample] != expected { concurrentStop.fail(.formatUnsupported); break }
            }
            received += 1
        } else { usleep(25) }
    }
    if received != chunkCount { concurrentStop.stop() }
    guard group.wait(timeout: .now() + .seconds(1)) == .success,
          !concurrentStop.isStopped, received == chunkCount,
          concurrentRing.head.load() == concurrentRing.tail.load(),
          concurrentRing.queuedFrames.load() == 0 else { throw CaptureFailure.bufferOverflow }
    cases.append("concurrent-spsc-4096-chunks-and-slot-wrap")

    // Synthetic, anonymous pipes only. Never invoke a device/tap or write audio
    // to stdout here; test transport saturation and cancellation.
    func withPipe(_ body: (Int32, Int32) throws -> Void) throws {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { throw CaptureFailure.transportError }
        defer { close(fds[0]); close(fds[1]) }
        try nonblocking(fds[0]); try nonblocking(fds[1])
        try body(fds[0], fds[1])
    }
    func fillPipe(_ fd: Int32) throws {
        let padding = [UInt8](repeating: 0, count: 4096)
        var filled = false
        for _ in 0..<1024 {
            let written = padding.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
            if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { filled = true; break }
            if written < 0 { throw CaptureFailure.transportError }
        }
        guard filled else { throw CaptureFailure.transportError }
    }
    try withPipe { _, writeFD in
        try fillPipe(writeFD)
        var rejected = false
        let started = DispatchTime.now().uptimeNanoseconds
        do { try writePacket(packet, fd: writeFD, stop: StopState(), timeoutMs: 40) }
        catch CaptureFailure.transportError { rejected = true }
        guard rejected, DispatchTime.now().uptimeNanoseconds - started < 500_000_000 else {
            throw CaptureFailure.transportError
        }
    }
    cases.append("nonblocking-transport-deadline")
    try withPipe { _, writeFD in
        try fillPipe(writeFD)
        let state = StopState()
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(20)) { state.stop() }
        let started = DispatchTime.now().uptimeNanoseconds
        try writePacket(packet, fd: writeFD, stop: state)
        guard state.isStopped, DispatchTime.now().uptimeNanoseconds - started < 250_000_000 else {
            throw CaptureFailure.transportError
        }
    }
    cases.append("cancel-interrupts-full-output-pipe")
    let report: [String: Any] = ["ok": true, "tests": cases, "captureStarted": false, "protocol": 1]
    let reportData = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    FileHandle.standardOutput.write(reportData)
    FileHandle.standardOutput.write(Data([0x0a]))
}

signal(SIGPIPE, SIG_IGN)
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--self-test"] {
    do { try syntheticSelfTest(); exit(0) }
    catch {
        emitStatus(["type": "error", "code": (error as? CaptureFailure ?? .formatUnsupported).code])
        exit(1)
    }
} else if arguments == ["--version"] {
    print("{\"protocol\":1,\"minimumMacOS\":\"14.2\"}")
    exit(0)
} else if arguments.count == 3, arguments[0] == "--capture", arguments[1] == "--parent-pid",
          let parent = Int32(arguments[2]), parent > 1, parent == getppid() {
    do {
        try nonblocking(STDOUT_FILENO)
        try nonblocking(STDERR_FILENO)
        try nonblocking(STDIN_FILENO)
        guard #available(macOS 14.2, *) else { throw CaptureFailure.unsupported }
        let capture = SystemAudioCapture(parentPID: parent)
        capture.run()
        withExtendedLifetime(capture) { dispatchMain() }
    } catch {
        emitStatus(["type": "error", "code": (error as? CaptureFailure ?? .deviceUnavailable).code])
        exit(1)
    }
} else {
    emitStatus(["type": "error", "code": CaptureFailure.invalidRequest.code])
    exit(2)
}

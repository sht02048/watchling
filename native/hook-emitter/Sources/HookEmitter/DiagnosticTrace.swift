#if WATCHLING_NATIVE_TRACE
import Darwin

struct DiagnosticTrace: Sendable {
    enum Stage: UInt32 {
        case mainEntry = 1
        case descriptorBegin = 2
        case descriptorEnd = 3
        case stdinBegin = 4
        case stdinEnd = 5
        case projectionBegin = 6
        case projectionEnd = 7
        case connectBegin = 8
        case connectEnd = 9
        case sendBegin = 10
        case sendEnd = 11
        case normalReturn = 12
        case watchdogExit = 13
        case rejected = 14
    }

    private let descriptor: Int32?
    private let pid: UInt32

    init() {
        pid = UInt32(bitPattern: Darwin.getpid())
        let fd: Int32 = 3
        var metadata = stat()
        let inspected = Darwin.fstat(fd, &metadata)
        let kind = metadata.st_mode & mode_t(S_IFMT)
        guard inspected == 0, kind == mode_t(S_IFIFO) || kind == mode_t(S_IFSOCK) else {
            descriptor = nil
            return
        }
        let flags = Darwin.fcntl(fd, F_GETFL)
        guard flags >= 0,
            Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
            Darwin.fcntl(fd, F_SETNOSIGPIPE, 1) == 0
        else {
            descriptor = nil
            return
        }
        descriptor = fd
    }

    func reject(_ failedStage: Stage) {
        record(.rejected, detail: Int32(failedStage.rawValue))
    }

    // Call sites are outside all loops. The main path attempts at most 13 records;
    // the independent watchdog attempts one, so even their exit race stays below 32.
    // Each attempt is one fixed-size, nonblocking write; failures/partials are dropped.
    func record(_ stage: Stage, detail: Int32 = 0) {
        guard let descriptor else { return }
        let savedErrno = errno
        defer { errno = savedErrno }
        let uptime = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        let threadCpu = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        withUnsafeTemporaryAllocation(byteCount: 32, alignment: 8) { storage in
            guard let base = storage.baseAddress else { return }
            base.storeBytes(of: UInt32(0x50414754).littleEndian, toByteOffset: 0, as: UInt32.self)
            base.storeBytes(of: stage.rawValue.littleEndian, toByteOffset: 4, as: UInt32.self)
            base.storeBytes(of: pid.littleEndian, toByteOffset: 8, as: UInt32.self)
            base.storeBytes(of: detail.littleEndian, toByteOffset: 12, as: Int32.self)
            base.storeBytes(of: uptime.littleEndian, toByteOffset: 16, as: UInt64.self)
            base.storeBytes(of: threadCpu.littleEndian, toByteOffset: 24, as: UInt64.self)
            _ = Darwin.write(descriptor, base, 32)
        }
    }
}
#endif

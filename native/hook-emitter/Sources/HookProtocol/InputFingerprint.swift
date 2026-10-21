import CryptoKit
import Foundation

public enum CanonicalJSON: Decodable, Equatable, Sendable {
    case null
    case bool(Bool)
    case integer(Int64)
    case double(Double)
    case string(String)
    case array([CanonicalJSON])
    case object([String: CanonicalJSON])

    public static let maximumDepth = 64
    public static let maximumNodes = 10_000

    private final class Budget {
        var remaining = CanonicalJSON.maximumNodes
    }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }

        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private enum LimitError: Error {
        case exceeded
    }

    public init(from decoder: Decoder) throws {
        try self.init(from: decoder, depth: 0, budget: Budget())
    }

    private init(from decoder: Decoder, depth: Int, budget: Budget) throws {
        budget.remaining -= 1
        guard depth < Self.maximumDepth, budget.remaining >= 0 else { throw LimitError.exceeded }
        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
        } else if let value = try? single.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? single.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? single.decode(Double.self) {
            self = .double(value)
        } else if let value = try? single.decode(String.self) {
            self = .string(value)
        } else if var items = try? decoder.unkeyedContainer() {
            var values: [CanonicalJSON] = []
            while !items.isAtEnd {
                values.append(try CanonicalJSON(from: items.superDecoder(), depth: depth + 1, budget: budget))
            }
            self = .array(values)
        } else {
            let fields = try decoder.container(keyedBy: Key.self)
            var values: [String: CanonicalJSON] = [:]
            for key in fields.allKeys {
                values[key.stringValue] = try CanonicalJSON(
                    from: fields.superDecoder(forKey: key), depth: depth + 1, budget: budget
                )
            }
            self = .object(values)
        }
    }

    public var canonicalBytes: [UInt8] {
        var output: [UInt8] = []
        write(to: &output)
        return output
    }

    private func write(to output: inout [UInt8]) {
        switch self {
        case .null:
            output.append(contentsOf: "null".utf8)
        case .bool(let value):
            output.append(contentsOf: (value ? "true" : "false").utf8)
        case .integer(let value):
            output.append(contentsOf: value.description.utf8)
        case .double(let value):
            output.append(contentsOf: value.description.utf8)
        case .string(let value):
            Self.write(string: value, to: &output)
        case .array(let values):
            output.append(UInt8(ascii: "["))
            for (index, value) in values.enumerated() {
                if index > 0 { output.append(UInt8(ascii: ",")) }
                value.write(to: &output)
            }
            output.append(UInt8(ascii: "]"))
        case .object(let values):
            output.append(UInt8(ascii: "{"))
            let keys = values.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            for (index, key) in keys.enumerated() {
                if index > 0 { output.append(UInt8(ascii: ",")) }
                Self.write(string: key, to: &output)
                output.append(UInt8(ascii: ":"))
                values[key]!.write(to: &output)
            }
            output.append(UInt8(ascii: "}"))
        }
    }

    private static let hexDigits = Array("0123456789abcdef".utf8)

    private static func write(string: String, to output: inout [UInt8]) {
        output.append(UInt8(ascii: "\""))
        for byte in string.utf8 {
            switch byte {
            case UInt8(ascii: "\""), UInt8(ascii: "\\"):
                output.append(UInt8(ascii: "\\"))
                output.append(byte)
            case 0x00...0x1F:
                output.append(contentsOf: "\\u00".utf8)
                output.append(hexDigits[Int(byte >> 4)])
                output.append(hexDigits[Int(byte & 0x0F)])
            default:
                output.append(byte)
            }
        }
        output.append(UInt8(ascii: "\""))
    }
}

public enum InputFingerprint {
    public static func fingerprint(toolName: String, input: CanonicalJSON, key: Data) -> String {
        var message = Array(toolName.utf8)
        message.append(0)
        message.append(contentsOf: input.canonicalBytes)
        let code = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
        return code.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    public static func key(token: String) -> Data? {
        guard let tokenBytes = bytes(hex: token) else { return nil }
        let derived = HMAC<SHA256>.authenticationCode(
            for: Array("pagent-fingerprint-v1".utf8), using: SymmetricKey(data: tokenBytes)
        )
        return Data(derived)
    }

    private static func bytes(hex: String) -> Data? {
        let bytes = Array(hex.utf8)
        guard bytes.count == 64 else { return nil }
        var data = Data(capacity: 32)
        var index = 0
        while index < bytes.count {
            guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else { return nil }
            data.append(high << 4 | low)
            index += 2
        }
        return data
    }

    private static func nibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
        default: nil
        }
    }
}

// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PagentHookEmitter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "pagent-hook-emitter", targets: ["HookEmitter"]),
    ],
    targets: [
        .target(name: "HookProtocol"),
        .executableTarget(name: "HookEmitter", dependencies: ["HookProtocol"]),
        .testTarget(name: "HookProtocolTests", dependencies: ["HookProtocol"]),
    ]
)

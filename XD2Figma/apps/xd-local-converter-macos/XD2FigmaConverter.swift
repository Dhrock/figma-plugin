import AppKit
import Darwin
import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct ConversionResult: Codable, Sendable {
    let outputDirectory: String
    let semanticPath: String
    let plainTextPath: String
    let packagePath: String
}

enum ConverterError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value): return value
        }
    }
}

enum ConverterEngine {
    static func smokeTest() throws -> String {
        let node = try nodeExecutable()
        let scripts = try scriptPaths()
        return "node=\(node)\ndirect=\(scripts.direct)\npackage=\(scripts.package)"
    }

    static func convert(source: URL, outputRoot: URL) throws -> ConversionResult {
        guard source.pathExtension.lowercased() == "xd" else {
            throw ConverterError.message(".xdファイルを選択してください。")
        }
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw ConverterError.message("XDファイルが見つかりません: \(source.path)")
        }
        try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)

        let node = try nodeExecutable()
        let scripts = try scriptPaths()
        let directOutput = try run(node, [scripts.direct, "--source", source.path, "--out-root", outputRoot.path])
        guard let semanticPath = directOutput
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .first(where: { $0.hasSuffix("/semantic.json") }) else {
            throw ConverterError.message("直接解析結果からsemantic.jsonの保存先を取得できませんでした。\n\(directOutput)")
        }

        let directory = URL(fileURLWithPath: semanticPath).deletingLastPathComponent()
        let plainTextPath = directory.appendingPathComponent("texts.json").path
        let coordinatesPath = directory.appendingPathComponent("coordinates.csv").path
        let assetsPath = directory.appendingPathComponent("assets").path
        let packageOutput = try run(node, [
            scripts.package,
            "--semantic", semanticPath,
            "--texts", plainTextPath,
            "--coordinates", coordinatesPath,
            "--assets", assetsPath,
            "--source-xd", source.path,
        ])
        guard let packagePath = packageOutput
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .first(where: { $0.hasSuffix(".xd2fig") }) else {
            throw ConverterError.message("パッケージの保存先を取得できませんでした。\n\(packageOutput)")
        }

        let result = ConversionResult(
            outputDirectory: directory.path,
            semanticPath: semanticPath,
            plainTextPath: plainTextPath,
            packagePath: packagePath
        )
        try updateCompletionMarker(result: result, source: source, directory: directory)
        return result
    }

    private static func scriptPaths() throws -> (direct: String, package: String) {
        guard let resourceURL = Bundle.main.resourceURL else {
            throw ConverterError.message("アプリのResourcesディレクトリが見つかりません。")
        }
        let root = resourceURL.appendingPathComponent("converter", isDirectory: true)
        let direct = root.appendingPathComponent("xd-direct-cli.cjs").path
        let package = root.appendingPathComponent("package-cli.cjs").path
        guard FileManager.default.fileExists(atPath: direct), FileManager.default.fileExists(atPath: package) else {
            throw ConverterError.message("変換エンジンがアプリ内にありません。アプリを再ビルドしてください。")
        }
        return (direct, package)
    }

    private static func nodeExecutable() throws -> String {
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("runtime/node").path,
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
        ].compactMap { $0 }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        let discovered = try? run("/bin/zsh", ["-lc", "command -v node"]).trimmingCharacters(in: .whitespacesAndNewlines)
        if let discovered, !discovered.isEmpty, FileManager.default.isExecutableFile(atPath: discovered) {
            return discovered
        }
        throw ConverterError.message("Node.jsが見つかりません。Node.js 20以降をインストールしてください。")
    }

    @discardableResult
    private static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let error = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let outputText = String(decoding: output, as: UTF8.self)
        let errorText = String(decoding: error, as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw ConverterError.message(errorText.isEmpty ? outputText : errorText)
        }
        return outputText
    }

    private static func updateCompletionMarker(result: ConversionResult, source: URL, directory: URL) throws {
        let markerURL = directory.appendingPathComponent("export-complete.json")
        var marker: [String: Any] = [:]
        if let data = try? Data(contentsOf: markerURL),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            marker = existing
        }
        marker["completed"] = true
        marker["mode"] = "xd-file-local-app"
        marker["source"] = source.lastPathComponent
        marker["texts"] = result.plainTextPath
        marker["package"] = result.packagePath
        marker["completedAt"] = ISO8601DateFormatter().string(from: Date())
        let data = try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: markerURL, options: .atomic)
    }
}

@MainActor
final class ConverterViewModel: ObservableObject {
    @Published var selectedFile: URL?
    @Published var outputRoot: URL
    @Published var isRunning = false
    @Published var status = "XDファイルを選択してください。"
    @Published var result: ConversionResult?

    init() {
        if let stored = UserDefaults.standard.string(forKey: "outputRoot"), !stored.isEmpty {
            outputRoot = URL(fileURLWithPath: stored, isDirectory: true)
        } else if let resource = Bundle.main.resourceURL?.appendingPathComponent("default-output-path.txt"),
                  let value = try? String(contentsOf: resource, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty {
            outputRoot = URL(fileURLWithPath: value, isDirectory: true)
        } else {
            outputRoot = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Documents/XD2Figma/output", isDirectory: true)
        }
    }

    func chooseXD() {
        let panel = NSOpenPanel()
        panel.title = "変換するAdobe XDファイルを選択"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "xd") ?? .data]
        if panel.runModal() == .OK, let url = panel.url {
            selectedFile = url
            result = nil
            status = "選択済み: \(url.lastPathComponent)"
        }
    }

    func chooseOutputRoot() {
        let panel = NSOpenPanel()
        panel.title = "出力先の親フォルダを選択"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = outputRoot
        if panel.runModal() == .OK, let url = panel.url {
            outputRoot = url
            UserDefaults.standard.set(url.path, forKey: "outputRoot")
        }
    }

    func convert() {
        guard let source = selectedFile else {
            status = "先にXDファイルを選択してください。"
            return
        }
        let output = outputRoot
        isRunning = true
        result = nil
        status = "XD内部データを直接解析し、texts.jsonと.xd2figを生成しています…"
        Task {
            do {
                let converted = try await Task.detached(priority: .userInitiated) {
                    try ConverterEngine.convert(source: source, outputRoot: output)
                }.value
                result = converted
                status = "変換が完了しました。\n\(converted.packagePath)"
            } catch {
                status = "変換エラー:\n\(error.localizedDescription)"
            }
            isRunning = false
        }
    }

    func revealResult() {
        guard let result else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: result.packagePath)])
    }
}

struct ContentView: View {
    @StateObject private var model = ConverterViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text("XD2Figma Local Converter")
                    .font(.system(size: 24, weight: .bold))
                Text("Adobe XDを起動せず、XDファイルからテキスト・座標・画像を抽出して.xd2figまで生成します。")
                    .foregroundStyle(.secondary)
            }

            GroupBox("1. XDファイル") {
                HStack {
                    Text(model.selectedFile?.path ?? "未選択")
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("XDを選択…") { model.chooseXD() }
                        .disabled(model.isRunning)
                }
                .padding(8)
            }

            GroupBox("2. 出力先") {
                HStack {
                    Text(model.outputRoot.path)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("変更…") { model.chooseOutputRoot() }
                        .disabled(model.isRunning)
                }
                .padding(8)
            }

            HStack {
                Button("変換を開始") { model.convert() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.selectedFile == nil || model.isRunning)
                if model.isRunning { ProgressView().controlSize(.small) }
                Spacer()
                Button("Finderで表示") { model.revealResult() }
                    .disabled(model.result == nil || model.isRunning)
            }

            ScrollView {
                Text(model.status)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(minHeight: 130)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            Text("出力: semantic.json / texts.json（文字列とGUIDのみ）/ coordinates.csv / assets / .xd2fig")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(minWidth: 720, minHeight: 500)
    }
}

@main
struct XD2FigmaConverterApp: App {
    init() {
        let arguments = CommandLine.arguments
        if arguments.contains("--smoke-test") {
            do {
                print(try ConverterEngine.smokeTest())
                Darwin.exit(0)
            } catch {
                fputs("\(error.localizedDescription)\n", stderr)
                Darwin.exit(1)
            }
        }
        if let convertIndex = arguments.firstIndex(of: "--convert"),
           convertIndex + 1 < arguments.count,
           let outputIndex = arguments.firstIndex(of: "--output"),
           outputIndex + 1 < arguments.count {
            do {
                let result = try ConverterEngine.convert(
                    source: URL(fileURLWithPath: arguments[convertIndex + 1]),
                    outputRoot: URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
                )
                let data = try JSONEncoder().encode(result)
                print(String(decoding: data, as: UTF8.self))
                Darwin.exit(0)
            } catch {
                fputs("\(error.localizedDescription)\n", stderr)
                Darwin.exit(1)
            }
        }
    }

    var body: some Scene {
        WindowGroup { ContentView() }
            .windowResizability(.contentMinSize)
        Settings { EmptyView() }
    }
}

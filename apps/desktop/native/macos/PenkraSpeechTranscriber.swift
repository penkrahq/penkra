// FILE: PenkraSpeechTranscriber.swift
// Purpose: Provides a narrow on-device macOS SpeechTranscriber process boundary.
// Layer: Bundled desktop native helper

import AVFoundation
import Foundation
import Speech

private struct CapabilitiesResponse: Encodable {
    let appleSpeech: AppleSpeechCapability?
}

private struct AppleSpeechCapability: Encodable {
    let locale: String
}

private struct TranscriptionResponse: Encodable {
    let text: String
}

private struct ErrorResponse: Encodable {
    let error: String
}

private enum HelperError: LocalizedError {
    case invalidArguments
    case unsupportedSystem
    case unsupportedLocale(String)
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Invalid speech helper arguments."
        case .unsupportedSystem:
            return "Apple on-device transcription is unavailable on this Mac."
        case let .unsupportedLocale(locale):
            return "Apple on-device transcription does not support locale \(locale)."
        case .emptyTranscript:
            return "Apple on-device transcription did not return any text."
        }
    }
}

private func writeJSON<T: Encodable>(_ value: T, to handle: FileHandle) throws {
    let data = try JSONEncoder().encode(value)
    handle.write(data)
    handle.write(Data([0x0A]))
}

@available(macOS 26.0, *)
private func resolveSupportedLocale(_ requested: Locale) async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    return await SpeechTranscriber.supportedLocale(equivalentTo: requested)
}

@available(macOS 26.0, *)
private func ensureAssets(for transcriber: SpeechTranscriber) async throws {
    let status = await AssetInventory.status(forModules: [transcriber])
    guard status != .unsupported else {
        throw HelperError.unsupportedSystem
    }
    if status == .installed { return }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }
}

@available(macOS 26.0, *)
private func transcribeFile(at path: String, locale requestedLocale: Locale) async throws -> String {
    guard let locale = await resolveSupportedLocale(requestedLocale) else {
        throw HelperError.unsupportedLocale(requestedLocale.identifier)
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    try await ensureAssets(for: transcriber)

    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    async let transcript = transcriber.results.reduce(into: "") { result, segment in
        result.append(String(segment.text.characters))
    }

    if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        await analyzer.cancelAndFinishNow()
    }

    let text = try await transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw HelperError.emptyTranscript }
    return text
}

private func capabilities() async -> CapabilitiesResponse {
    guard #available(macOS 26.0, *) else {
        return CapabilitiesResponse(appleSpeech: nil)
    }
    guard let locale = await resolveSupportedLocale(Locale.current) else {
        return CapabilitiesResponse(appleSpeech: nil)
    }
    return CapabilitiesResponse(
        appleSpeech: AppleSpeechCapability(locale: locale.identifier(.bcp47))
    )
}

@main
private struct PenkraSpeechTranscriber {
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first else { throw HelperError.invalidArguments }
            switch command {
            case "capabilities":
                try writeJSON(await capabilities(), to: .standardOutput)
            case "transcribe":
                guard arguments.count == 3 else { throw HelperError.invalidArguments }
                guard #available(macOS 26.0, *) else { throw HelperError.unsupportedSystem }
                let text = try await transcribeFile(
                    at: arguments[1],
                    locale: Locale(identifier: arguments[2])
                )
                try writeJSON(TranscriptionResponse(text: text), to: .standardOutput)
            default:
                throw HelperError.invalidArguments
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            try? writeJSON(ErrorResponse(error: message), to: .standardError)
            Foundation.exit(1)
        }
    }
}

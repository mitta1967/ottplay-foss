import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Imported files live in application storage, independent of the source document/provider.
@objc(LocalMedia)
public class LocalMedia: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "LocalMediaPlugin"
    public let jsName = "LocalMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]
    private let queue = DispatchQueue(label: "ott.offline-media", qos: .userInitiated)
    private var pendingPicker: CAPPluginCall?
    private struct Entry: Codable {
        let id: String
        let name: String
        let filename: String
        let mime: String
    }
    private func directory() throws -> URL {
        var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: true).appendingPathComponent("offline-media", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Video libraries can be large; they should not consume iCloud backups.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
    }
    private func regularPrivateFile(_ file: URL, in directory: URL) -> Bool {
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true else { return false }
        return file.resolvingSymlinksInPath().standardizedFileURL ==
            directory.resolvingSymlinksInPath().appendingPathComponent(file.lastPathComponent).standardizedFileURL
    }
    public override func load() {
        queue.async {
            guard let directory = try? self.directory(),
                  let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
            for file in files where file.pathExtension != "json" {
                let id = file.deletingPathExtension().lastPathComponent
                if UUID(uuidString: id) != nil && !FileManager.default.fileExists(atPath: directory.appendingPathComponent(id + ".json").path) {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
    }
    private func snapshot() throws -> [String: Any] {
        let directory = try directory()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let items: [[String: Any]] = files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { metadata in
            guard regularPrivateFile(metadata, in: directory),
                  let data = try? Data(contentsOf: metadata), let entry = try? JSONDecoder().decode(Entry.self, from: data),
                  UUID(uuidString: entry.id) != nil, !entry.filename.contains("/"),
                  entry.filename.hasPrefix(entry.id + ".") else { return nil }
            let file = directory.appendingPathComponent(entry.filename)
            guard regularPrivateFile(file, in: directory),
                  let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let size = attributes[.size] as? NSNumber,
                  let url = bridge?.portablePath(fromLocalURL: file) else { return nil }
            return ["id": entry.id, "name": entry.name, "mime": entry.mime, "size": size.int64Value,
                    "url": url.absoluteString]
        }
        return ["available": true, "persistent": true, "storage": "device", "items": items]
    }
    @objc func list(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { call.reject("Local media unavailable"); return }
            do { call.resolve(try self.snapshot()) } catch { call.reject("Local media unavailable") }
        }
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil else { call.reject("Invalid local media ID"); return }
        queue.async { [weak self] in
            guard let self else { call.reject("Local media unavailable"); return }
            do {
                let directory = try self.directory()
                let metadata = directory.appendingPathComponent(id + ".json")
                if FileManager.default.fileExists(atPath: metadata.path) {
                    let entry = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: metadata))
                    guard entry.filename.hasPrefix(id + "."), !entry.filename.contains("/") else {
                        call.reject("Invalid local media record"); return
                    }
                    try FileManager.default.removeItem(at: directory.appendingPathComponent(entry.filename))
                    try FileManager.default.removeItem(at: metadata)
                }
                call.resolve(try self.snapshot())
            } catch { call.reject("Unable to delete local media") }
        }
    }
    @objc func importFiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingPicker == nil else { call.reject("A media picker is already open"); return }
            guard let presenter = self.bridge?.viewController else { call.reject("Media picker unavailable"); return }
            self.pendingPicker = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.movie, .audio], asCopy: false)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPicker else { return }
        pendingPicker = nil
        list(call)
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPicker else { return }
        pendingPicker = nil
        guard urls.count <= 128 else { call.reject("Import at most 128 files at once"); return }
        queue.async {
            var created: [URL] = []
            do {
                let directory = try self.directory()
                for source in urls {
                    let access = source.startAccessingSecurityScopedResource()
                    defer { if access { source.stopAccessingSecurityScopedResource() } }
                    let ext = source.pathExtension.lowercased()
                    guard let type = UTType(filenameExtension: ext), type.conforms(to: .movie) || type.conforms(to: .audio) else {
                        throw CocoaError(.fileReadUnsupportedScheme)
                    }
                    let sourceValues = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                    guard sourceValues.isRegularFile == true, sourceValues.isSymbolicLink != true else {
                        throw CocoaError(.fileReadUnsupportedScheme)
                    }
                    let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
                    guard let size = attributes[.size] as? NSNumber, size.int64Value <= 8 * 1024 * 1024 * 1024 else {
                        throw CocoaError(.fileReadTooLarge)
                    }
                    let id = UUID().uuidString.lowercased()
                    let filename = id + "." + ext
                    let destination = directory.appendingPathComponent(filename)
                    let metadata = directory.appendingPathComponent(id + ".json")
                    created.append(destination); created.append(metadata)
                    try FileManager.default.copyItem(at: source, to: destination)
                    guard self.regularPrivateFile(destination, in: directory) else { throw CocoaError(.fileReadUnsupportedScheme) }
                    let entry = Entry(id: id, name: String(source.lastPathComponent.prefix(256)), filename: filename,
                                      mime: type.preferredMIMEType ?? "application/octet-stream")
                    try JSONEncoder().encode(entry).write(to: metadata, options: .atomic)
                }
                call.resolve(try self.snapshot())
            } catch {
                created.forEach { try? FileManager.default.removeItem(at: $0) }
                call.reject("Media import failed; check file type and free storage")
            }
        }
    }
}

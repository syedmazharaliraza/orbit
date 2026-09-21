import CryptoKit
import Darwin
import Foundation

// Observation-only Claude Code hook collector. Every failure is deliberately
// silent and exits successfully so observation can never control Claude.
let maximumInput = 8 * 1024 * 1024
let maximumRecord = 64 * 1024

func argument(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

func bounded(_ value: Any?, _ limit: Int) -> String? {
    guard let string = value as? String else { return nil }
    return String(string.prefix(limit))
}

func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

func toolInput(_ raw: Any?) -> [String: Any] {
    guard let input = raw as? [String: Any] else { return [:] }
    var result: [String: Any] = [:]
    for key in ["file_path", "path", "notebook_path"] {
        if let item = bounded(input[key], 4096) { result[key] = item }
    }
    for key in ["pattern", "query"] {
        if let item = bounded(input[key], 512) { result[key] = item }
    }
    if let command = input["command"] as? String { result["command_fingerprint"] = digest(command) }
    if let questions = input["questions"] as? [[String: Any]] {
        result["questions"] = questions.prefix(8).compactMap { item -> [String: Any]? in
            guard let question = bounded(item["question"], 1024) else { return nil }
            var clean: [String: Any] = ["question": question, "multiSelect": item["multiSelect"] as? Bool == true]
            if let header = bounded(item["header"], 128) { clean["header"] = header }
            if let options = item["options"] as? [[String: Any]] {
                clean["options"] = options.prefix(16).compactMap { option -> [String: Any]? in
                    guard let label = bounded(option["label"], 256) else { return nil }
                    var cleanOption: [String: Any] = ["label": label]
                    if let description = bounded(option["description"], 512) { cleanOption["description"] = description }
                    return cleanOption
                }
            }
            return clean
        }
    }
    return result
}

func minimize(event: String, payload: [String: Any]) -> [String: Any] {
    var result: [String: Any] = [:]
    for key in ["session_id", "incarnation_id", "agent_id", "prompt_id", "tool_use_id", "elicitation_id"] {
        if let item = bounded(payload[key], 512) { result[key] = item }
    }
    if let cwd = bounded(payload["cwd"], 4096) { result["cwd"] = cwd }
    if let model = bounded(payload["model"], 256) { result["model"] = model }
    if let title = bounded(payload["session_title"], 512) { result["session_title"] = title }
    if let source = bounded(payload["source"], 64) { result["source"] = source }
    if let context = payload["context"] as? [String: Any], let effort = context["effort"] as? [String: Any], let level = bounded(effort["level"], 64) {
        result["context"] = ["effort": ["level": level]]
    }

    switch event {
    case "UserPromptSubmit":
        if let prompt = bounded(payload["prompt"], 360) { result["prompt"] = prompt }
    case "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied":
        if let name = bounded(payload["tool_name"], 256) { result["tool_name"] = name }
        result["tool_input"] = toolInput(payload["tool_input"])
        if let error = bounded(payload["error"], 1024) { result["error"] = error }
        if payload["is_interrupt"] as? Bool == true { result["is_interrupt"] = true }
    case "PostToolBatch":
        if let results = payload["results"] as? [[String: Any]] {
            result["results"] = results.prefix(64).map { item in
                var clean: [String: Any] = [:]
                if let id = bounded(item["tool_use_id"], 512) { clean["tool_use_id"] = id }
                if let status = bounded(item["status"], 32) { clean["status"] = status }
                return clean
            }
        }
    case "Notification":
        if let type = bounded(payload["notification_type"], 128) { result["notification_type"] = type }
    case "Elicitation":
        if let server = bounded(payload["server_name"], 256) { result["server_name"] = server }
        if let mode = bounded(payload["mode"], 64) { result["mode"] = mode }
        if let request = payload["request"] as? [String: Any] { result["request"] = Dictionary(uniqueKeysWithValues: request.keys.prefix(64).map { ($0, true) }) }
    case "ElicitationResult":
        if let action = bounded(payload["action"], 64) { result["action"] = action }
    case "Stop", "SubagentStop":
        if let message = bounded(payload["last_assistant_message"], 2048) { result["last_assistant_message"] = message }
        if payload["stop_hook_active"] as? Bool == true { result["stop_hook_active"] = true }
    case "StopFailure":
        if let error = bounded(payload["error"], 1024) { result["error"] = error }
    case "SessionEnd":
        if let reason = bounded(payload["reason"], 256) { result["reason"] = reason }
    case "SubagentStart":
        if let type = bounded(payload["agent_type"], 128) { result["agent_type"] = type }
    case "PostModelSwitch":
        if let model = bounded(payload["to_model"], 256) { result["to_model"] = model }
    case "CwdChanged":
        if let cwd = bounded(payload["new_cwd"], 4096) { result["new_cwd"] = cwd }
    case "DirectoryAdded":
        if let directory = bounded(payload["directory"], 4096) { result["directory"] = directory }
    case "TaskCreated", "TaskCompleted":
        if let id = bounded(payload["task_id"], 512) { result["task_id"] = id }
        if let subject = bounded(payload["subject"], 512) { result["subject"] = subject }
    default: break
    }
    return result
}

func run() {
    guard CommandLine.arguments.contains("observe"), let event = argument(after: "--event") else { return }
    guard let input = try? FileHandle.standardInput.read(upToCount: maximumInput + 1), input.count <= maximumInput,
          let json = try? JSONSerialization.jsonObject(with: input),
          let payload = json as? [String: Any] else { return }

    let environment = ProcessInfo.processInfo.environment
    let inbox: URL
    if let configured = argument(after: "--inbox"), !configured.isEmpty {
        inbox = URL(fileURLWithPath: configured, isDirectory: true)
    } else if let configured = environment["ORBIT_HOOK_INBOX"], !configured.isEmpty {
        inbox = URL(fileURLWithPath: configured, isDirectory: true)
    } else {
        inbox = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Orbit/claude-observation/inbox", isDirectory: true)
    }
    try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: inbox.path)

    let id = UUID().uuidString.lowercased()
    let record: [String: Any] = [
        "schemaVersion": 1,
        "eventId": id,
        "event": event,
        "collectorObservedAt": Int(Date().timeIntervalSince1970 * 1000),
        "payload": minimize(event: event, payload: payload)
    ]
    guard let output = try? JSONSerialization.data(withJSONObject: record), output.count <= maximumRecord else { return }
    let temporary = inbox.appendingPathComponent(".\(id).tmp")
    let committed = inbox.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(id).json")
    guard FileManager.default.createFile(atPath: temporary.path, contents: output, attributes: [.posixPermissions: 0o600]) else { return }
    do { try FileManager.default.moveItem(at: temporary, to: committed) } catch { try? FileManager.default.removeItem(at: temporary) }
}

run()
exit(0)

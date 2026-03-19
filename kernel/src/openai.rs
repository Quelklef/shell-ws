use serde::{Deserialize, Serialize};

use crate::model::{Node, NodeKind, Workspace};

const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL: &str = "gpt-5.1";
const MAX_SAMPLE_CHARS: usize = 4_096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateScriptRequest {
    pub workspace: Workspace,
    pub node_id: String,
    #[serde(default)]
    pub stdin_sample: Option<String>,
    #[serde(default)]
    pub argv_samples: Vec<ArgvSample>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArgvSample {
    pub slot: usize,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateScriptResponse {
    pub script: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: &'static str,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatAssistantMessage,
}

#[derive(Debug, Deserialize)]
struct ChatAssistantMessage {
    content: AssistantContent,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AssistantContent {
    Text(String),
    Parts(Vec<AssistantContentPart>),
}

#[derive(Debug, Deserialize)]
struct AssistantContentPart {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

pub async fn generate_script(
    client: &reqwest::Client,
    request: GenerateScriptRequest,
) -> Result<GenerateScriptResponse, String> {
    let node = request
        .workspace
        .nodes
        .iter()
        .find(|node| node.id == request.node_id)
        .ok_or_else(|| format!("Node {} was not found in the provided workspace", request.node_id))?;

    if node.kind != NodeKind::AiScript {
        return Err(format!(
            "Node {} is not an ai_script node",
            request.node_id
        ));
    }

    let api_key = request
        .workspace
        .openai_api_key
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err("Workspace OpenAI API key is empty".to_string());
    }

    let description = node.description.clone().unwrap_or_default();
    if description.trim().is_empty() {
        return Err("AI SCRIPT description is empty".to_string());
    }

    let body = ChatCompletionRequest {
        model: DEFAULT_MODEL,
        messages: build_messages(node, &request.stdin_sample, &request.argv_samples),
    };

    let response = client
        .post(OPENAI_RESPONSES_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("OpenAI request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unavailable>".to_string());
        return Err(format!("OpenAI request failed with {status}: {body}"));
    }

    let response: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to decode OpenAI response: {error}"))?;

    let content = response
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "OpenAI returned no completion choices".to_string())?
        .message
        .content;

    let script = strip_markdown_fences(&assistant_content_to_text(content));
    if script.trim().is_empty() {
        return Err("OpenAI returned an empty script".to_string());
    }

    Ok(GenerateScriptResponse { script })
}

fn assistant_content_to_text(content: AssistantContent) -> String {
    match content {
        AssistantContent::Text(text) => text,
        AssistantContent::Parts(parts) => parts
            .into_iter()
            .filter(|part| part.kind == "text")
            .filter_map(|part| part.text)
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn build_messages(
    node: &Node,
    stdin_sample: &Option<String>,
    argv_samples: &[ArgvSample],
) -> Vec<ChatMessage> {
    let shell = node.shell_value();
    let mut user_sections = vec![
        format!("Shell: {shell}"),
        format!(
            "Task:\n{}",
            node.description.clone().unwrap_or_default().trim()
        ),
    ];

    let current_script = node.script.clone().unwrap_or_default();
    if !current_script.trim().is_empty() {
        user_sections.push(format!("Current script to replace or revise:\n{current_script}"));
    }

    if node.include_sample_inputs.unwrap_or(false) {
        if let Some(stdin) = stdin_sample.as_ref().filter(|sample| !sample.trim().is_empty()) {
            user_sections.push(format!(
                "Previous stdin sample:\n{}",
                truncate_sample(stdin)
            ));
        }

        if !argv_samples.is_empty() {
            let formatted = argv_samples
                .iter()
                .map(|sample| {
                    format!(
                        "argv-{}:\n{}",
                        sample.slot,
                        truncate_sample(&sample.value)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            user_sections.push(format!("Previous argv samples:\n{formatted}"));
        }
    }

    vec![
        ChatMessage {
            role: "system",
            content: [
                "You write shell scripts for a local automation tool.",
                "Return only the script body.",
                "Do not wrap the script in Markdown code fences.",
                "Do not include any explanation before or after the script.",
                "Prefer portable POSIX-compatible shell unless the request clearly depends on shell-specific features.",
            ]
            .join(" "),
        },
        ChatMessage {
            role: "user",
            content: user_sections.join("\n\n"),
        },
    ]
}

fn truncate_sample(sample: &str) -> String {
    let truncated: String = sample.chars().take(MAX_SAMPLE_CHARS).collect();
    if sample.chars().count() > MAX_SAMPLE_CHARS {
        format!("{truncated}\n[truncated]")
    } else {
        truncated
    }
}

fn strip_markdown_fences(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }

    let mut lines = trimmed.lines().collect::<Vec<_>>();
    if lines.first().is_some_and(|line| line.trim_start().starts_with("```")) {
        lines.remove(0);
    }
    if lines.last().is_some_and(|line| line.trim() == "```") {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_messages, strip_markdown_fences, ArgvSample};
    use crate::model::{Node, NodeKind, Position, Size};

    fn ai_node() -> Node {
        Node {
            id: "ai-script-1".to_string(),
            kind: NodeKind::AiScript,
            title: String::new(),
            comment: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            size: Size {
                width: 320.0,
                height: 240.0,
            },
            shell: Some("bash".to_string()),
            script: Some("echo old".to_string()),
            description: Some("Print a greeting using stdin.".to_string()),
            include_sample_inputs: Some(true),
            path: None,
            args: None,
            text: None,
            materialized_inputs: Default::default(),
            materialized_outputs: Default::default(),
            auto_run: None,
            ui_state: Default::default(),
        }
    }

    #[test]
    fn prompt_includes_samples_when_enabled() {
        let messages = build_messages(
            &ai_node(),
            &Some("hello world".to_string()),
            &[ArgvSample {
                slot: 1,
                value: "sample-arg".to_string(),
            }],
        );
        let user = &messages[1].content;
        assert!(user.contains("Previous stdin sample"));
        assert!(user.contains("hello world"));
        assert!(user.contains("argv-1"));
        assert!(user.contains("sample-arg"));
    }

    #[test]
    fn prompt_omits_samples_when_disabled() {
        let mut node = ai_node();
        node.include_sample_inputs = Some(false);
        let messages = build_messages(
            &node,
            &Some("hello world".to_string()),
            &[ArgvSample {
                slot: 1,
                value: "sample-arg".to_string(),
            }],
        );
        let user = &messages[1].content;
        assert!(!user.contains("Previous stdin sample"));
        assert!(!user.contains("Previous argv samples"));
    }

    #[test]
    fn strip_markdown_fences_removes_wrapping_block() {
        let script = strip_markdown_fences("```bash\necho hi\n```");
        assert_eq!(script, "echo hi");
    }
}

use crate::models::Status;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub const MAX_EVENTS_PER_AGENT: usize = 200;
const MAX_TEXT: usize = 240;

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Prompt,
    Reasoning,
    ToolStart,
    ToolResult,
    Response,
    Status,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActivityEvent {
    pub sequence: u64,
    pub agent_id: String,
    pub timestamp: String,
    pub kind: ActivityKind,
    pub title: String,
    pub detail: Option<String>,
    pub status: Status,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActivityInput {
    pub kind: ActivityKind,
    pub title: String,
    pub detail: Option<String>,
}

#[derive(Debug, Default)]
pub struct ActivityStore {
    next_sequence: u64,
    events: HashMap<String, VecDeque<ActivityEvent>>,
}

pub type SharedActivityStore = Arc<Mutex<ActivityStore>>;

impl ActivityStore {
    pub fn new() -> Self {
        Self { next_sequence: 1, events: HashMap::new() }
    }

    pub fn append(&mut self, agent_id: &str, timestamp: &str, status: Status, input: ActivityInput) {
        let event = ActivityEvent {
            sequence: self.next_sequence,
            agent_id: agent_id.to_string(),
            timestamp: timestamp.to_string(),
            kind: input.kind,
            title: sanitize(&input.title),
            detail: input.detail.map(|detail| sanitize(&detail)),
            status,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        let events = self.events.entry(agent_id.to_string()).or_default();
        events.push_back(event);
        while events.len() > MAX_EVENTS_PER_AGENT {
            events.pop_front();
        }
    }

    pub fn after(&self, agent_id: &str, after: u64, limit: usize) -> Vec<ActivityEvent> {
        self.events
            .get(agent_id)
            .into_iter()
            .flat_map(|events| events.iter())
            .filter(|event| event.sequence > after)
            .take(limit.clamp(1, MAX_EVENTS_PER_AGENT))
            .cloned()
            .collect()
    }
}

pub fn shared_activity_store() -> SharedActivityStore {
    Arc::new(Mutex::new(ActivityStore::new()))
}

pub(crate) fn sanitize(input: &str) -> String {
    let mut text = input.replace('\n', " ").replace('\r', " ");
    for key in ["authorization", "bearer", "api_key", "apikey", "access_token", "password"] {
        let lower = text.to_lowercase();
        if let Some(index) = lower.find(key) {
            text.replace_range(index.., "[redacted]");
        }
    }
    text.chars().take(MAX_TEXT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_keeps_order_and_limit() {
        let mut store = ActivityStore::new();
        for index in 0..(MAX_EVENTS_PER_AGENT + 2) {
            store.append(
                "a",
                "2026-01-01T00:00:00Z",
                Status::Thinking,
                ActivityInput { kind: ActivityKind::Status, title: index.to_string(), detail: None },
            );
        }
        let events = store.after("a", 0, MAX_EVENTS_PER_AGENT);
        assert_eq!(events.len(), MAX_EVENTS_PER_AGENT);
        assert_eq!(events[0].title, "2");
        assert!(events[0].sequence < events[1].sequence);
    }

    #[test]
    fn redacts_common_credentials() {
        let mut store = ActivityStore::new();
        store.append(
            "a",
            "now",
            Status::ToolUse,
            ActivityInput { kind: ActivityKind::ToolStart, title: "Authorization: Bearer secret".into(), detail: Some("api_key=hidden".into()) },
        );
        let event = store.after("a", 0, 1).remove(0);
        assert!(!event.title.contains("secret"));
        assert!(!event.detail.unwrap().contains("hidden"));
    }
}

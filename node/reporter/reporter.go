package reporter

import "github.com/LangYa466/Wolf-Monitor/node/collector"

// Reporter sends reports to the master. Implementations may keep a persistent
// connection (websocket) or be stateless (http).
type Reporter interface {
	// Send delivers a single report. It returns an error if delivery failed so
	// the caller can decide whether to reconnect/back off.
	Send(r collector.Report) error
	Close() error
}

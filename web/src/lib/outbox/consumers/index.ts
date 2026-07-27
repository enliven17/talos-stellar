/**
 * Side-effect import: registers every outbox consumer. Anything that
 * dispatches events (the drain route, the worker script) must import this
 * before calling dispatchOnce() — writeOutboxEvent()-only call sites don't
 * need it.
 */
import "./log-consumer";

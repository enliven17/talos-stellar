"""Action names recognized by the policy middleware."""

GATED_ACTIONS: frozenset[str] = frozenset(
    {
        "purchase_service",
        "transfer_xlm",
        "airdrop_pulse",
        "execute_approved_transfer",
        "request_defi_loan",
        "repay_loan",
        "register_service",
        "publish_content",
        "fulfill_job",
        "generate_playbook",
        "create_pulse_token",
    }
)

BYPASS_ACTIONS: frozenset[str] = frozenset(
    {
        "normalize_providers",
        "plan_purchase",
        "discover_services",
        "get_xlm_balance",
        "get_pulse_balance",
        "get_active_loans",
        "get_pending_jobs",
        "get_publishing_channels",
        "check_approval",
        "check_x_mentions",
        "check_post_performance",
        "poll_service_result",
        "evaluate_marketplace_bid",
    }
)

# Registered tools without an explicit policy gate retain their existing
# behavior; new tool names must be added to one of the registered sets.
REGISTERED_COMPAT_ACTIONS: frozenset[str] = frozenset(
    {
        "apply_playbook",
        "browse_page",
        "claim_job",
        "compose_a2a_plan",
        "evict_expired_learnings",
        "evolve_strategy",
        "get_active_playbook",
        "get_audience_insights",
        "get_budget_status",
        "get_channel_mentions",
        "get_content_history",
        "get_learnings",
        "get_performance_dashboard",
        "get_profile_stats",
        "get_schedule_status",
        "measure_recent_posts",
        "post_to_x",
        "record_performance",
        "record_post",
        "reply_on_channel",
        "reply_on_x",
        "report_activity",
        "report_revenue",
        "request_approval",
        "run_performance_review",
        "save_research_notes",
        "search_channel",
        "search_web",
        "search_x",
    }
)

KNOWN_ACTIONS = GATED_ACTIONS | BYPASS_ACTIONS | REGISTERED_COMPAT_ACTIONS
"""Explicit whole-site snapshots; aggregation and reset policy belong to callers."""
import math


def report_statistics(request, links_sent_successfully, average_messages_per_chat):
    """Validate then POST using an authenticated supervisor-style request helper."""
    if (type(links_sent_successfully) is not int or
            not 0 <= links_sent_successfully <= 9007199254740991):
        raise ValueError("links_sent_successfully must be a nonnegative safe integer")
    average = average_messages_per_chat
    if average is not None and (type(average) not in (int, float) or
                                not 0 <= average <= 1000000000 or
                                not math.isfinite(average)):
        raise ValueError("average_messages_per_chat must be null or finite in [0, 1000000000]")
    return request("POST", "/statistics", json={
        "links_sent_successfully": links_sent_successfully,
        "average_messages_per_chat": average,
    })

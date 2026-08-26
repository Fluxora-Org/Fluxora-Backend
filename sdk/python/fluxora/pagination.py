"""
Cursor Pagination Helpers
~~~~~~~~~~~~~~~~~~~~~~~~~

Iterator implementing cursor-based pagination semantics per src/validation/paginationSchema.ts.
"""

from typing import TypeVar, Generic, List, Optional, Callable, Iterator, Any, Dict

T = TypeVar("T")


class StreamPaginator(Generic[T]):
    """
    Cursor-based pagination helper for listing streams.

    Automatically handles fetching pages, managing opaque cursor tokens (`next_cursor`),
    and enforcing limit constraints (1..100, default 20) per src/validation/paginationSchema.ts.

    :param fetch_page: Function executing HTTP page request with query parameters.
    :param limit: Results per page (1..100, default 20).
    :param status: Optional stream status filter ('scheduled', 'active', 'paused', 'completed', 'cancelled').
    :param sender: Optional Stellar sender address filter.
    :param recipient: Optional Stellar recipient address filter.
    :param include_total: Whether to compute point-in-time total match count.
    """
    def __init__(
        self,
        fetch_page: Callable[..., Dict[str, Any]],
        limit: int = 20,
        status: Optional[str] = None,
        sender: Optional[str] = None,
        recipient: Optional[str] = None,
        include_total: bool = False,
    ):
        if limit < 1 or limit > 100:
            raise ValueError("limit must be an integer between 1 and 100 per paginationSchema")
        self.fetch_page = fetch_page
        self.limit = limit
        self.status = status
        self.sender = sender
        self.recipient = recipient
        self.include_total = include_total
        self._next_cursor: Optional[str] = None
        self._has_more: bool = True
        self._page_count: int = 0

    def __iter__(self) -> Iterator[List[T]]:
        """Iterate page-by-page, yielding lists of items."""
        return self

    def __next__(self) -> List[T]:
        if not self._has_more:
            raise StopIteration

        res = self.fetch_page(
            cursor=self._next_cursor,
            limit=self.limit,
            status=self.status,
            sender=self.sender,
            recipient=self.recipient,
            include_total=self.include_total,
        )

        data = res.get("data", []) if isinstance(res, dict) else getattr(res, "data", [])
        meta = res.get("meta", {}) if isinstance(res, dict) else getattr(res, "meta", {})

        next_cursor = None
        if isinstance(meta, dict):
            next_cursor = meta.get("next_cursor")
        elif hasattr(meta, "next_cursor"):
            next_cursor = getattr(meta, "next_cursor")

        self._page_count += 1
        if next_cursor:
            self._next_cursor = next_cursor
        else:
            self._has_more = False

        return data

    def auto_paginate(self) -> Iterator[T]:
        """
        Flatten page iterations into a continuous generator of individual items.

        :return: Generator yielding single items sequentially across all pages.
        """
        for page in self:
            for item in page:
                yield item

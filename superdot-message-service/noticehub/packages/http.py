"""SuperDot HTTP handlers for packages."""

from __future__ import annotations

import urllib.parse

from noticehub.platform.timeutil import now_local


class PackageRoutes:
    def _route_get_package(self, path: str) -> None:
        package_id = urllib.parse.unquote(path.removeprefix("/api/packages/"))
        self._product_response(
            lambda: self.store.read_package(package_id),
            {"OK": 200, "INVALID_INPUT": 400, "REF_NOT_FOUND": 404},
        )

    def _route_post_frontend_package(self, path: str) -> None:
        self._product_response(
            lambda: self.store.submit_frontend_package(self._product_body(), now_local()),
            {"QUEUED": 202, "REPLAYED": 200, "INVALID_INPUT": 400, "CONFLICT": 409, "REF_NOT_FOUND": 404},
        )

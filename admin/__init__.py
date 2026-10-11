"""Admin panel for the team, served at /monitor.

Accounts: create the first (super) account on the server with
    .venv/bin/flask --app app create-admin <username>
which asks for the password; further accounts are added in the panel by a super administrator.
"""
import os
from datetime import timedelta

import click

from . import queries
from .views import bp

URL_PREFIX = "/monitor"


def register(app):
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        # browsers only send the cookie over HTTPS; set CAMPUSMAPS_DEV=1 for a local http:// test server
        SESSION_COOKIE_SECURE=os.environ.get("CAMPUSMAPS_DEV") != "1",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    )
    app.register_blueprint(bp, url_prefix=URL_PREFIX)

    @app.cli.command("create-admin")
    @click.argument("username")
    @click.option("--role", type=click.Choice(["super", "editor"]), default="super", show_default=True)
    @click.password_option(confirmation_prompt=True)
    def create_admin(username, role, password):
        """Create an admin panel account (asks for the password)."""
        from .views import USERNAME_RE, PASSWORD_MIN
        if not USERNAME_RE.match(username):
            raise click.BadParameter("3–32 lowercase letters, digits, '.', '_' or '-'", param_hint="USERNAME")
        if len(password) < PASSWORD_MIN:
            raise click.BadParameter(f"at least {PASSWORD_MIN} characters", param_hint="password")
        with app.app_context():
            if queries.get_admin(username):
                raise click.ClickException(f"{username} already exists")
            queries.create_admin(username, password, role)
            queries.audit(username, "account.created_cli", username, role)
        click.echo(f"created {role} account {username}")

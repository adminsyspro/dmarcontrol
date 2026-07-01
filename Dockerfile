# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY static ./static

RUN cargo build --release --locked

RUN curl -fsSL -o /tmp/ip66.mmdb https://downloads.ip66.dev/db/ip66.mmdb

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --home-dir /app --shell /usr/sbin/nologin dmarcontrol

WORKDIR /app

RUN mkdir -p /app/data /usr/local/share/dmarcontrol

COPY --from=builder /app/target/release/dmarcontrol /usr/local/bin/dmarcontrol
COPY --from=builder /tmp/ip66.mmdb /usr/local/share/dmarcontrol/ip66.mmdb

RUN chown -R dmarcontrol:dmarcontrol /app

USER dmarcontrol

ENV ADDR=0.0.0.0:8080
ENV DATA_DIR=/app/data

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["dmarcontrol"]

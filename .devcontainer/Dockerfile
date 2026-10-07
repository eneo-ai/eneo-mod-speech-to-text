FROM mcr.microsoft.com/devcontainers/python:3.14-bookworm@sha256:8179b9d5f68dab0def4e113f924e6aed989a636e65ab58fbe0c8e808b046ac40

# The upstream image can contain a stale Yarn apt source. Dev Container features
# run apt-get update while installing tooling, so remove that source first.
RUN find /etc/apt/sources.list.d -type f -name '*yarn*' -delete \
    && if [ -f /etc/apt/sources.list ]; then sed -i '/dl.yarnpkg.com/d' /etc/apt/sources.list; fi

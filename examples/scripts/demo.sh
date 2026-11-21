#!/bin/sh
# 冒烟用的演示命令：输出时间、任务和环境变量，退出码 0。
set -eu
echo "demo ok at $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "job=${IMCRON_JOB:-unknown} occurrence=${IMCRON_OCCURRENCE:-unknown}"

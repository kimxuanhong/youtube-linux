#!/bin/bash

# Script để test MPRIS events

echo "=== Monitoring MPRIS events for YouTube ==="
echo "Start the YouTube app and play a video, then exit to see events"
echo ""

# Monitor MPRIS D-Bus messages
dbus-monitor "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2'" 2>&1 | \
while read -r line; do
    echo "[$(date '+%H:%M:%S')] $line"
done

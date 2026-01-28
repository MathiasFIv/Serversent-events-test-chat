using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using server.Entities;

namespace server.Controllers;

[ApiController]
[Route("thechat")]
public class TheChatController : ControllerBase
{
    private const int TypingTtlMs = 3500;

    private static readonly List<ClientInfo> Clients = new();
    private static readonly object ClientsLock = new();
    private static int _typingLoopStarted;

    // ============================================================================
    // SSE helpers
    // ============================================================================

    /// <summary>
    /// Writes a single Server-Sent Events frame with an event name and JSON payload.
    /// </summary>
    private static async Task WriteSseEventAsync(Stream stream, string eventName, object payload, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes($"event: {eventName}\ndata: {json}\n\n");
        await stream.WriteAsync(bytes, ct);
        await stream.FlushAsync(ct);
    }

    // ============================================================================
    // Typing state + expiry loop
    // ============================================================================

    /// <summary>
    /// Starts a background loop (once) that expires typing state after <see cref="TypingTtlMs"/>.
    /// </summary>
    private static void EnsureTypingExpiryLoopStarted()
    {
        if (Interlocked.Exchange(ref _typingLoopStarted, 1) == 1)
            return;

        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    await Task.Delay(300);

                    var now = DateTimeOffset.UtcNow;

                    List<(string userId, string username)> expiredUsers;
                    List<ClientInfo> snapshot;

                    lock (ClientsLock)
                    {
                        snapshot = Clients.ToList();
                    }

                    expiredUsers = snapshot
                        .GroupBy(c => c.UserId)
                        .Select(g =>
                        {
                            var anyTyping = g.Any(c => c.IsTyping);
                            var last = g.Max(c => c.LastTypingUtc);
                            var username = g.Last().Username;

                            if (!anyTyping)
                                return (userId: g.Key, username, expired: false);

                            var expired = last is null || (now - last.Value).TotalMilliseconds > TypingTtlMs;
                            return (userId: g.Key, username, expired);
                        })
                        .Where(x => x.expired)
                        .Select(x => (x.userId, x.username))
                        .ToList();

                    if (expiredUsers.Count == 0)
                        continue;

                    foreach (var (userId, username) in expiredUsers)
                    {
                        bool changed = false;
                        List<ClientInfo> recipients;

                        lock (ClientsLock)
                        {
                            foreach (var c in Clients.Where(c => c.UserId == userId))
                            {
                                if (c.IsTyping)
                                {
                                    c.IsTyping = false;
                                    changed = true;
                                }
                            }

                            recipients = Clients.ToList();
                        }

                        if (!changed)
                            continue;

                        var payload = new { userId, username, isTyping = false, ts = now };

                        foreach (var client in recipients)
                        {
                            try
                            {
                                await WriteSseEventAsync(client.Stream, "typing", payload);
                            }
                            catch
                            {
                            }
                        }
                    }
                }
                catch
                {
                }
            }
        });
    }

    /// <summary>
    /// Broadcasts a typing event to all connected clients.
    /// </summary>
    private static async Task BroadcastTypingAsync(string userId, string username, bool isTyping)
    {
        List<ClientInfo> snapshot;
        lock (ClientsLock)
        {
            snapshot = Clients.ToList();
        }

        var payload = new
        {
            userId,
            username,
            isTyping,
            expiresInMs = isTyping ? TypingTtlMs : (int?)null,
            ts = DateTimeOffset.UtcNow,
        };

        foreach (var client in snapshot)
        {
            try
            {
                await WriteSseEventAsync(client.Stream, "typing", payload);
            }
            catch
            {
            }
        }
    }

    // ============================================================================
    // Endpoints
    // ============================================================================

    /// <summary>
    /// SSE stream used by clients to receive chat messages and typing events.
    /// </summary>
    [HttpGet("stream")]
    public async Task Stream([FromQuery] string? userId, [FromQuery] string? username)
    {
        EnsureTypingExpiryLoopStarted();

        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";

        var finalUserId = string.IsNullOrWhiteSpace(userId) ? Guid.NewGuid().ToString("N") : userId.Trim();
        var finalUsername = string.IsNullOrWhiteSpace(username) ? $"User-{finalUserId[..Math.Min(4, finalUserId.Length)]}" : username.Trim();

        var client = new ClientInfo
        {
            Id = Guid.NewGuid(),
            UserId = finalUserId,
            Username = finalUsername,
            Stream = Response.Body,
        };

        lock (ClientsLock)
        {
            Clients.Add(client);
        }

        await WriteSseEventAsync(Response.Body, "hello", new { userId = finalUserId, username = finalUsername }, HttpContext.RequestAborted);

        try
        {
            while (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                await Task.Delay(1000, HttpContext.RequestAborted);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            bool shouldBroadcastStop = false;

            lock (ClientsLock)
            {
                Clients.Remove(client);

                var stillConnected = Clients.Any(c => c.UserId == finalUserId);
                if (!stillConnected)
                {
                    var anyTyping = Clients.Any(c => c.UserId == finalUserId && c.IsTyping);
                    shouldBroadcastStop = client.IsTyping || anyTyping;

                    foreach (var c in Clients.Where(c => c.UserId == finalUserId))
                        c.IsTyping = false;
                }
            }

            if (shouldBroadcastStop)
            {
                await BroadcastTypingAsync(finalUserId, finalUsername, isTyping: false);
            }
        }
    }

    /// <summary>
    /// Typing keepalive ping. Broadcasts typing=true on every call so clients can refresh their local expiry.
    /// </summary>
    [HttpPost("typing")]
    public async Task<IActionResult> Typing([FromBody] TypingPing ping)
    {
        EnsureTypingExpiryLoopStarted();

        var userId = ping.UserId.Trim();
        if (userId.Length == 0)
            return BadRequest("userId is required");

        var now = DateTimeOffset.UtcNow;

        string username;

        lock (ClientsLock)
        {
            var userClients = Clients.Where(c => c.UserId == userId).ToList();
            username = userClients.LastOrDefault()?.Username ?? "Anonymous";

            foreach (var c in userClients)
            {
                c.LastTypingUtc = now;
                c.IsTyping = true;
            }
        }

        await BroadcastTypingAsync(userId, username, isTyping: true);

        return NoContent();
    }

    /// <summary>
    /// Sends a chat message to all connected clients.
    /// </summary>
    [HttpPost("send")]
    public async Task SendMessage([FromBody] Message message, [FromQuery] string? userId)
    {
        var fromUserId = string.IsNullOrWhiteSpace(userId) ? null : userId.Trim();
        string fromUsername;

        lock (ClientsLock)
        {
            fromUsername = fromUserId is null
                ? "Anonymous"
                : Clients.LastOrDefault(c => c.UserId == fromUserId)?.Username ?? "Anonymous";
        }

        var payload = new
        {
            id = Guid.NewGuid().ToString("N"),
            from = fromUsername,
            content = message.Content,
            ts = DateTimeOffset.UtcNow,
        };

        List<ClientInfo> snapshot;
        lock (ClientsLock)
        {
            snapshot = Clients.ToList();
        }

        var dead = new List<ClientInfo>();
        foreach (var client in snapshot)
        {
            try
            {
                await WriteSseEventAsync(client.Stream, "message", payload, HttpContext.RequestAborted);
            }
            catch
            {
                dead.Add(client);
            }
        }

        if (dead.Count > 0)
        {
            lock (ClientsLock)
            {
                foreach (var d in dead)
                    Clients.Remove(d);
            }
        }
    }
}


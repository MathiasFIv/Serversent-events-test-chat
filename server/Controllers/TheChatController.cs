using System.Text;
using Microsoft.AspNetCore.Mvc;

namespace server.Controllers;

[ApiController]
[Route("thechat")]

public class TheChatController : ControllerBase
{
    private static readonly List<System.IO.Stream> Clients = new();

    [HttpGet("stream")]
    public async Task Stream()
    {
        Response.Headers.ContentType = "text/event-stream";
        Clients.Add(Response.Body);
        await Response.Body.FlushAsync();
        try
        {
            while (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                await Task.Delay(1000);
            }
        }
        finally
        {
            Clients.Remove(Response.Body);
        }
    }

    [HttpPost("send")]
    public async Task SendMessage([FromBody] Message message)
    {
        var messageData = Encoding.UTF8.GetBytes($"data: {message.Content}\n\n");

        foreach (var client in Clients)
        {
            try
            {
                await client.WriteAsync(messageData);
                await client.FlushAsync();
            }
            catch
            {
                Clients.Remove(client);
            }
        }
    }
}
using System.Text.Json;
using System.Text;
using Yarn;
using Yarn.Compiler;
using Yarn.Markup;

Console.InputEncoding = Encoding.UTF8;
Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

try
{
    var input = JsonSerializer.Deserialize<PreviewInput>(Console.In.ReadToEnd(), json)
        ?? throw new InvalidOperationException("Missing preview input");
    Console.WriteLine(JsonSerializer.Serialize(Preview(input), json));
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { error = error.Message }, json));
}

static object Preview(PreviewInput input)
{
    var storage = new MemoryVariableStore();
    var dialogue = new Dialogue(storage);
    var random = new Random(input.Seed);
    // Replaying the same choices must replay the same random draws.
    foreach (var name in new[] { "random", "random_range", "random_range_float", "dice" })
        dialogue.Library.DeregisterFunction(name);
    dialogue.Library.RegisterFunction("random", () => (float)random.NextDouble());
    dialogue.Library.RegisterFunction("random_range", (float minimum, float maximum) =>
        random.Next((int)maximum - (int)minimum + 1) + minimum);
    dialogue.Library.RegisterFunction("random_range_float", (float minimum, float maximum) =>
        random.Next((int)maximum - (int)minimum + 1) + minimum);
    dialogue.Library.RegisterFunction("dice", (int sides) => random.Next(sides) + 1);

    var job = CompilationJob.CreateFromString("script.yarn", input.Source);
    var compiled = Compiler.Compile(job);
    var diagnostics = compiled.Diagnostics.Select(item => new
    {
        severity = item.Severity.ToString().ToLowerInvariant(),
        message = item.Message,
        line = item.Range.Start.Line + 1
    }).ToArray();
    var stringTable = compiled.StringTable;
    if (compiled.Program is null || stringTable is null || compiled.Diagnostics.Any(item => item.Severity == Diagnostic.DiagnosticSeverity.Error))
        return new { diagnostics };

    var nodes = compiled.Program.Nodes.Keys.Order().ToArray();
    if (input.CheckOnly) return new { diagnostics, nodes };
    if (!compiled.Program.Nodes.ContainsKey(input.StartNode))
        return new { error = $"找不到起始节点 {input.StartNode}", diagnostics, nodes };

    var lines = new List<object>();
    var options = Array.Empty<PreviewOption>();
    var step = 0;
    var waiting = false;
    var complete = false;
    var currentNode = input.StartNode;
    var transcriptLength = 0;

    string Text(Line line) =>
        LineParser.ExpandSubstitutions(stringTable[line.ID].text ?? "", line.Substitutions);

    void AddLine(string kind, string text)
    {
        transcriptLength += text.Length;
        if (lines.Count >= 300 || transcriptLength > 80_000)
            throw new InvalidOperationException("预览文本超出限制，请从更近的节点开始。");
        lines.Add(new { kind, text, node = currentNode });
    }

    dialogue.LineHandler = line => AddLine("line", Text(line));
    dialogue.CommandHandler = command => AddLine("command", command.Text);
    dialogue.NodeStartHandler = start => currentNode = start;
    dialogue.DialogueCompleteHandler = () => complete = true;
    dialogue.LogErrorMessage = message => throw new InvalidOperationException(message);
    dialogue.OptionsHandler = group =>
    {
        if (step == input.Choices.Length)
        {
            options = group.Options.Select(option =>
                new PreviewOption(option.ID, Text(option.Line), option.IsAvailable)).ToArray();
            waiting = true;
            return;
        }
        var index = Array.FindIndex(group.Options, option =>
            option.ID == input.Choices[step] && option.IsAvailable);
        if (index < 0)
            throw new InvalidOperationException("所选分支当前不可用，请重新开始预览。");
        var selection = group.Options[index];
        step++;
        AddLine("choice", Text(selection.Line));
        dialogue.SetSelectedOption(selection.ID);
    };

    dialogue.SetProgram(compiled.Program);
    dialogue.SetNode(input.StartNode);
    do
    {
        dialogue.Continue();
    } while (!waiting && dialogue.IsActive);

    if (step < input.Choices.Length)
        return new { error = "预览在选项序列结束前已完成，请重新开始。", diagnostics, nodes };
    var variables = new Dictionary<string, object>();
    foreach (var name in compiled.Declarations.Select(item => item.Name)
        .Where(name => name.StartsWith('$') && !name.StartsWith("$Yarn.Internal.")).Distinct().Take(80))
    {
        if (storage.TryGetValue<bool>(name, out var boolValue)) variables[name] = boolValue;
        else if (storage.TryGetValue<float>(name, out var number) && float.IsFinite(number)) variables[name] = number;
        else if (storage.TryGetValue<string>(name, out var text)) variables[name] = text;
    }
    return new { diagnostics, nodes, lines, options, complete, currentNode, variables };
}

record PreviewInput(string Source, string StartNode, int[] Choices, int Seed, bool CheckOnly);
record PreviewOption(int Id, string Text, bool Available);

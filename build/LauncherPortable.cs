using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace PostGull.Launcher
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            // 1. 查找 cat_monitor.py
            string pyScript = null;
            string explicitHome = Environment.GetEnvironmentVariable("POSTGULL_HOME");
            if (!string.IsNullOrEmpty(explicitHome) && Directory.Exists(explicitHome))
            {
                string p1 = Path.Combine(explicitHome, "cat_monitor.py");
                string p2 = Path.Combine(explicitHome, "monitor", "cat_monitor.py");
                if (File.Exists(p1)) pyScript = p1;
                else if (File.Exists(p2)) pyScript = p2;
            }

            if (pyScript == null)
            {
                string[] scriptCandidates = new string[]
                {
                    Path.Combine(baseDir, "monitor", "cat_monitor.py"),
                    Path.Combine(baseDir, "cat_monitor.py"),
                    Path.Combine(baseDir, "..", "monitor", "cat_monitor.py"),
                    Path.Combine(baseDir, "..", "cat_monitor.py")
                };

                foreach (var sc in scriptCandidates)
                {
                    try
                    {
                        string fullPath = Path.GetFullPath(sc);
                        if (File.Exists(fullPath))
                        {
                            pyScript = fullPath;
                            break;
                        }
                    }
                    catch { }
                }
            }

            if (pyScript == null)
            {
                MessageBox.Show(
                    "未找到监控面板脚本 (cat_monitor.py)。\n\n请确认该启动器位于 PostGull 项目根目录或 dist 目录下，或者设置 POSTGULL_HOME 环境变量指向项目路径。",
                    "PostGull 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            string workingDir = Path.GetDirectoryName(pyScript);

            // 2. 查找可用 Python (优先寻找 pythonw.exe 无控制台运行)
            string pythonExe = null;
            string customPy = Environment.GetEnvironmentVariable("POSTGULL_PYTHON");
            if (!string.IsNullOrEmpty(customPy) && File.Exists(customPy))
            {
                pythonExe = customPy;
            }

            if (pythonExe == null)
            {
                // 常见标准安装路径探测
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string[] candidates = new string[]
                {
                    // PATH 优先检查
                    FindInPath("pythonw.exe"),
                    FindInPath("pyw.exe"),
                    // LocalAppData 标准路径
                    Path.Combine(localAppData, @"Programs\Python\Python313\pythonw.exe"),
                    Path.Combine(localAppData, @"Programs\Python\Python312\pythonw.exe"),
                    Path.Combine(localAppData, @"Programs\Python\Python311\pythonw.exe"),
                    Path.Combine(localAppData, @"Programs\Python\Python310\pythonw.exe"),
                    // Program Files
                    Path.Combine(progFiles, @"Python313\pythonw.exe"),
                    Path.Combine(progFiles, @"Python312\pythonw.exe"),
                    Path.Combine(progFiles, @"Python311\pythonw.exe"),
                    Path.Combine(progFiles, @"Python310\pythonw.exe"),
                    // 盘符根目录常规路径
                    @"C:\Python313\pythonw.exe",
                    @"C:\Python312\pythonw.exe",
                    @"C:\Python311\pythonw.exe",
                    @"C:\Python310\pythonw.exe",
                    // Windows py 启动器
                    @"C:\Windows\pyw.exe",
                    @"C:\Windows\py.exe",
                    // 回退到标准控制台 python
                    FindInPath("python.exe")
                };

                foreach (var c in candidates)
                {
                    if (!string.IsNullOrEmpty(c) && File.Exists(c))
                    {
                        pythonExe = c;
                        break;
                    }
                }
            }

            if (pythonExe == null)
            {
                MessageBox.Show(
                    "未检测到 Python 运行环境。\n\n请先安装 Python 3 并勾选添加环境变量 (确保 tkinter 可用)，或配置 POSTGULL_PYTHON 环境变量指向 pythonw.exe。",
                    "PostGull 启动提示",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            // 3. 启动进程
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = pythonExe;
            if (Path.GetFileName(pythonExe).Equals("py.exe", StringComparison.OrdinalIgnoreCase))
            {
                psi.Arguments = "-3 \"" + pyScript + "\"";
            }
            else
            {
                psi.Arguments = "\"" + pyScript + "\"";
            }
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;

            try
            {
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动监控面板失败:\n" + ex.Message,
                    "PostGull 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private static string FindInPath(string fileName)
        {
            try
            {
                string pathEnv = Environment.GetEnvironmentVariable("PATH");
                if (string.IsNullOrEmpty(pathEnv)) return null;

                string[] paths = pathEnv.Split(';');
                foreach (var p in paths)
                {
                    string trimmed = p.Trim();
                    if (string.IsNullOrEmpty(trimmed)) continue;
                    string full = Path.Combine(trimmed, fileName);
                    if (File.Exists(full))
                    {
                        return full;
                    }
                }
            }
            catch { }
            return null;
        }
    }
}

"""The build engine: the project's own Makefiles, Kconfig and scripts, run by
WebFlash itself.

Plain Python that runs under CPython (the maintainer commands, CI, tests) and
under Pyodide (the browser) without change. The pieces: ``make`` (the make
interpreter), ``shell`` (the recipe commands), ``pyrun`` (the project's own
Python scripts, in process), ``kconfig`` (the project's kconfiglib),
``driver`` (GCC command lines to the LLVM tools), ``toolchain`` (how a tool is
run: subprocesses, a JavaScript function, or Node), ``uf2``, ``inspect`` and
``build`` (one firmware build, start to finish). ``cli`` holds the maintainer
subcommands.
"""

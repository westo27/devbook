function notes --description 'Show today\'s work-notes file (or a given YYYY-MM-DD)'
    set -l dir ~/Documents/work-notes/daily
    set -l day (date +%Y-%m-%d)
    if test (count $argv) -ge 1
        set day $argv[1]
    end
    set -l file $dir/$day.md
    if test -e $file
        cat $file
    else
        echo "No notes for $day ($file)"
    end
end

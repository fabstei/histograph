/*
  Shared tasks for manage.js script
  
*/
var settings   = require('../../settings'),
    neo4j      = require('seraph')(settings.neo4j.host),
    fs         = require('fs'),
    csv        = require('csv'),
    generator  = require('../../generator')(),
    inquirer   = require('inquirer'),
    exectimer  = require('exectimer');
    
module.exports = {
  utils: {
    
    /*
      merge by options.property two or more nodes from the options.records collection. .
      Always ask for confirmation before merging.
    */
    mergeMany: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.utils.mergeMany'));
      if(_.isEmpty(options.property)) {
        return callback(' Please specify the property with --property');
      }
      console.log(clc.blackBright('   merge by:'), options.property);
      var groups,
          toBeUpdated,
          toBeMerged;
      // groups of rows by propoerty ;)    
      groups = _.values(_.groupBy(options.records, options.property));
      
      // nodes only to be updated
      toBeUpdated = _.flatten(groups.filter(function (d) {
        return d.length == 1
      }));
      
      // nodes to be merged
      toBeMerged = groups.filter(function (d) {
        return d.length > 1
      });
      
      // remove groups from memory (we creaed a copy)
      delete groups
      
      // output to the user
      console.log(clc.blackBright('   to be updated:', clc.magentaBright(toBeUpdated.length), '- to be merged:',clc.magentaBright(_.sum(toBeMerged, function (d) {return d.length})), 'nodes, in', clc.magentaBright(toBeMerged.length)));
    
      // first things first: update what need to be updated, with user confirmation
      var checkNodes = [];
      async.series([
        
        function merge(next) {
          var q = async.queue(function (group, nextGroup) {
            var ids = _.map(group, function (d) {return +d.id}),
                names = _.map(group, 'name');
            
            console.log(clc.blackBright('\n   merging nodes:',  clc.cyanBright(JSON.stringify(ids)), 'remaining:'),q.length());
            // collect all the relationships for the nodes
            neo4j.query('MATCH (n) WHERE id(n) in {ids} WITH n MATCH p=(n)-[r]-(t) RETURN n as node, r as rel', {
              ids: ids
            }, function (err, tuples) {
              if(err) {
                q.kill();
                next(err);
                return;
              };
              // ged differences in properties
              
              var ghosts = tuples.map(function (tuple) {
                var rel = tuple.rel
                if(ids.indexOf(rel.start) != -1 && rel.start != ids[0]) {
                  console.log(rel.start, '===== s ', ids[0]);
                  rel.new_start  = ids[0];
                  rel.new_end = rel.end
                  rel.CHANGE = true; 
                } else if(ids.indexOf(rel.end) != -1 && rel.end != ids[0]) {
                  console.log(rel.end, '===== e ', ids[0]);
                  rel.new_start  =  rel.start;
                  rel.new_end = ids[0]
                  rel.CHANGE = true; 
                }
                return rel;
              });
              
              var clones = _.values(_.groupBy(ghosts, function(d) {
                // everything except the ID
                return [d.start, d.end, d.type, JSON.stringify(d.properties)].join();
              }));
              
              var relToBeRemoved = _.flatten(clones.filter(function (d) {
                return d.length > 1;
              }).map(function (d) {
                return _.takeRight(_.map(d, 'id'), d.length -1);
              }));
              
              var relToBeUpdated = _.flatten(clones.map(function(d) {
                return _.first(d, 1);
              })).filter(function (d) {
                return d.CHANGE
              });
              
              var nodes = _.indexBy(_.map(tuples, 'node'), 'id');
              
             
              
              async.series([
                function compareNodeContents(nextStep) {
                  var needToBeReviewedBeforeMerging = false;
                  console.log(clc.blackBright('   slug:'), clc.cyanBright(_.first(_.map(group, 'slug'))));
                  console.log(clc.blackBright('   name:'),names);
                  
                  var quietlyUpdatable = {};
                  
                  for(var i = 0; i < ids.length; i++) {
                    for(var j = i; j < ids.length; j++) {
                      //var fields = _difference(_.keys(nodes[ids[i]], nodes[ids[j]]))
                      for(var k in nodes[ids[i]])
                        if(['id', 'full_search', 'caption_search', 'textrazor_annotated'].indexOf(k) == -1
                            && nodes[ids[i]][k] != nodes[ids[j]][k]
                              
                        ) {
                          if(_.isEmpty(nodes[ids[i]][k]) || _.isEmpty(nodes[ids[j]][k])) {
                            quietlyUpdatable[k] = _.unique(_.compact((quietlyUpdatable[k] || []).concat(nodes[ids[i]][k], nodes[ids[j]][k])))
                            continue;
                          }
                          if(typeof nodes[ids[i]][k] != 'object' || nodes[ids[i]][k].join() != nodes[ids[j]][k].join() )
                            k != 'full_search' && console.log(clc.yellowBright('   ',k),': \n    "', nodes[ids[i]][k] ,'" != \n    "', nodes[ids[j]][k], '"')  
                            needToBeReviewedBeforeMerging = true;
                        }
                    }
                  }
                  if(!needToBeReviewedBeforeMerging) {
                    console.log(clc.yellowBright('   nodes can be merged quietly'), 'resulting in:');
                    
                    nextStep();
                    return
                  }
                  
                  inquirer.prompt([{
                    type: 'confirm',
                    name: 'confirm',
                    message: ' The two nodes look very, very different ... continue the merging process?',
                  }], function (answers) {
                    if(answers.confirm) {
                      nextStep();
                    } else {
                      console.log(clc.yellowBright('skipping merge ...'));
                      nextStep('bad')
                    }
                  })
                },
                
                function merge(nextStep) {
                  console.log(clc.blackBright('   remove relationships:'), relToBeRemoved)
                  console.log(clc.blackBright('   update relationships:'), relToBeUpdated)
                  if(relToBeUpdated.length + relToBeRemoved.length == 0) {
                    console.log(clc.blackBright('   nothing to do, skipping', clc.cyanBright(JSON.stringify(ids))));
                    nextGroup();
                    return;
                  };
                  inquirer.prompt([{
                    type: 'confirm',
                    name: 'confirm',
                    message: ' Press enter to MERGE or REMOVE the selected relationships, otherwise SKIP by typing "n"',
                  }], function (answers) {
                    if(answers.confirm) {
                      nextGroup();
                      return;
                    } else {
                      console.log(clc.blackBright('   skipped, nothing changed for', clc.cyanBright(JSON.stringify(ids))));
                      nextGroup();
                      return;
                    }
                  });
                }
              ], nextGroup);
            });
          },1);
          q.push(toBeMerged);
          q.drain = next;
        },  
      ], function (err, results) { //eof async.series
        if(err)
          callback(err)
        else
          callback(null, options)
      });     
    }
  },
  tick: {
    start: function(options, callback) {
      options.verbose = (options.verbose == undefined) ? true : options.verbose;
      options.__tick = new exectimer.Tick("TIMER");
      if (options.verbose) {
        console.log(clc.yellowBright('\n   tasks.helpers.tick.start'));
      }
      options.__tick.start()
      callback(null, options)
    },
    end: function(options, callback) {
      options.__tick.stop();
      if (options.verbose) {
        console.log(clc.yellowBright('\n   tasks.helpers.tick.end'));
        console.log(clc.yellowBright("   It took: "), exectimer.timers.TIMER.duration()/1000000000, clc.yellowBright("sec."));
      }
      callback(exectimer.timers.TIMER.duration() / 1000000000, options)
    }
  },
  
  marvin: {
    create: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.marvin.create'));
      
      var User = require('../../models/user');
      User.remove(generator.user.marvin(), function (err) {
        if(err)
          callback(err);
        else {
          console.log(clc.blackBright('   generating user'), clc.magentaBright('MARVIN'));
          User.create(generator.user.marvin(), function (err, user) {
            if(err)
              callback(err)
            else {
              console.log(clc.blackBright('   user', clc.magentaBright('MARVIN'), 'generated'));
          
              callback(null, _.assign(options, {
                marvin: user
              }));
            }
          });
        }
      });
    },
    remove: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.marvin.remove'));
      var User = require('../../models/user');
      console.log(clc.blackBright('   removing user'), clc.magentaBright('MARVIN'));
          
      User.remove(generator.user.marvin(), function (err) {
        if(err)
          callback(err);
        else
          callback(null, options);
      });
    }
  },
  /*
    Print out a csv file, to be used in a waterfall, with err.
    require as options
      filepath
      records
      fields
  */
  csv: {
    stringify: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.csv.stringify'));
      csv.stringify(options.records, {
        delimiter: options.delimiter || '\t',
        columns:   options.fields,
        header:    true
      }, function (err, data) {
        fs.writeFile(options.filepath,
           data, function (err) {
          if(err) {
            callback(err);
            return
          }
          callback(null, options);
        })
      });
    },
    /*
      REQUIRE an absolute or relative to this file task
    */
    parse: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.csv.parse'));
      if(!options.source) {
        return callback(' Please specify the file path with --source=path/to/source.tsv');
      }
      csv.parse(''+fs.readFileSync(options.source), {
        columns : true,
        delimiter: options.delimiter || '\t'
      }, function (err, data) {
        if(err) {
          callback(err);
          return;
        }
        console.log(clc.blackBright('   parsing csv file completed,', clc.magentaBright(data.length), 'records found'));
        options.data = data;
        callback(null, options);
      });
    }
  },
  
  cypher: {
    raw: function(options, callback) {
      console.log(clc.yellowBright('\n   tasks.helpers.cypher.raw'));
      if(!options.cypher) {
        return callback(' Please specify the query path (decypher file without .cyp extension followed by / query name), e.g. --cypher=resource/count_related_users');
      }
      
      var path = options.cypher.split('/');
      
      if(path.length != 2) {
        return callback(' Please specify a valid query path, e.g. --cypher=resource/count_related_users, since you specified ' + options.cypher);
      }
        
      
      var neo4j     = require('seraph')(settings.neo4j.host),
          queries   = require('decypher')('./queries/' + path[0] + '.cyp'),
          parser    = require('../../parser.js'),
          query;
      
      if(!queries[path[1]]) {
        console.log(clc.blackBright('  queries available:'), _.keys(queries));
        return callback(' Please specify a valid query name with --name=<queryname>');
      
      }
      
      console.log(clc.blackBright('   executing query: ', clc.magentaBright(options.cypher), '...\n'));
      
      
      query = parser.agentBrown(queries[path[1]], options);
      console.log(query)
      
      
      neo4j.query(query, options, function (err, result) {
        console.log(clc.blackBright('\n   result: \n'));
        if(err)
          console.log(err);
        else
          console.log(result);
        
      callback(null, options);
      })
      
    }
    
  }
};